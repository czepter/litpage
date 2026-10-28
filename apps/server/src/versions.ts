// Page versions as one service for every surface: the Version history panel (api/modules/pages.ts), AI chat, Custom
// Agents and the MCP server (ai/tools). Snapshots themselves are written by history.ts; this module decides when a
// change deserves its own version (snapshotIfChanged, checkpoint before an AI / MCP edit), compares versions
// (lineDiff over their Markdown) and writes one back (restoreVersion: the page's blocks plus the databases it shows,
// with today's access rules, locks and comments kept).
import { newId } from '@nc/shared/ids.ts';
import { roleAtLeast } from '@nc/shared/permissions.ts';
import type { BlockRecord, CollectionRecord } from '@nc/shared/records.ts';
import { toPlainText } from '@nc/shared/richtext.ts';
import { isDatabaseLocked } from '@nc/shared/database/access.ts';
import { childrenOf, db, getRecord } from './db.ts';
import { applyTransactions, blockRole, type AppliedChange } from './records.ts';
import { getSnapshot, serializePage, takeSnapshot, type DatabaseSnapshot } from './history.ts';
import { restorableProperties } from './versionAccess.ts';
import { deletedSchemaOf } from './propaccess.ts';
import { pageIdOf } from './search.ts';

const PAGE_TYPES = new Set(['page', 'collection_view_page']);

// "Bookmark this version": a person's own names for versions
db.exec(`
CREATE TABLE IF NOT EXISTS snapshot_bookmarks (
  snapshot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  created_time INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, user_id)
);
`);

/** Name a version for `userId` (null removes the bookmark). */
export function bookmarkVersion(snapshotId: string, userId: string, name: string | null) {
  if (name === null) db.prepare('DELETE FROM snapshot_bookmarks WHERE snapshot_id = ? AND user_id = ?').run(snapshotId, userId);
  else db.prepare('INSERT INTO snapshot_bookmarks (snapshot_id, user_id, name, created_time) VALUES (?, ?, ?, ?) ON CONFLICT(snapshot_id, user_id) DO UPDATE SET name = excluded.name').run(snapshotId, userId, name.slice(0, 200), Date.now());
}

/** `userId`'s version names on a page: snapshot id → name. */
export function versionBookmarks(pageId: string, userId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of db.prepare('SELECT b.snapshot_id, b.name FROM snapshot_bookmarks b JOIN snapshots s ON s.id = b.snapshot_id WHERE s.page_id = ? AND b.user_id = ?').all(pageId, userId) as { snapshot_id: string; name: string | null }[]) {
    out[b.snapshot_id] = b.name || '';
  }
  return out;
}

export class VersionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** People who edited the page since its latest version (activity log), to credit a version taken now. */
export function authorsSince(pageId: string): string[] {
  const since = latestSnapshotRow(pageId)?.created_time ?? 0;
  return (db.prepare('SELECT DISTINCT user_id FROM activity WHERE page_id = ? AND COALESCE(json_extract(data, \'$.last\'), created_time) > ?')
    .all(pageId, since) as { user_id: string | null }[]).map((x) => x.user_id).filter((x): x is string => !!x);
}

/** The page whose version history holds `b`: a page or database row itself, else the page around the block (an
 *  inline database counts for the page showing it). */
export function versionedPageOf(b: BlockRecord): string {
  return PAGE_TYPES.has(b.type) ? b.id : pageIdOf(b);
}

/**
 * Save the current state of each page as a version unless it already is one (the checkpoint before an AI / MCP edit,
 * so the edit can be compared and undone through Version history). Returns the id of each page's latest version.
 */
export function checkpoint(pageIds: Iterable<string>, now = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of new Set(pageIds)) {
    const page = getRecord<BlockRecord>('block', id);
    if (!page || page.alive === false) continue;
    snapshotIfChanged(id, authorsSince(id), now);
    const row = latestSnapshotRow(id);
    if (row) out.set(id, row.id);
  }
  return out;
}

export interface RestoreResult {
  pageId: string;
  changes: AppliedChange[];
  /** inline databases the restorer couldn't restore (no full access, locked) */
  databasesUnchanged: number;
  /** the version saved right before the restore: restoring it undoes the restore */
  previousVersionId: string | null;
}

/** "Restore this version": snapshot the current state first, then write the version back. `restoreDatabases`
 *  ("Also restore databases on this page") brings back inline databases' properties and records too. `source` tags
 *  the commit like any other write of the caller (Custom Agents' trigger loop guard). */
export function restoreVersion(uid: string, snapshotId: string, opts: { restoreDatabases?: boolean; clientId?: string; source?: string } = {}): RestoreResult {
  const snap = getSnapshot(String(snapshotId ?? ''));
  if (!snap) throw new VersionError('Not found', 404);
  const page = getRecord<BlockRecord>('block', snap.pageId);
  if (!page) throw new VersionError('Not found', 404);
  const role = blockRole(page.id, uid);
  if (!roleAtLeast(role, 'read_and_write')) throw new VersionError(role === 'none' ? 'Not found' : 'Not allowed', role === 'none' ? 404 : 403);
  if (!page.alive) throw new VersionError('Restore the page from Trash before restoring its snapshots.', 400);
  const databases = (snap.data?.databases ?? {}) as Record<string, DatabaseSnapshot>;
  // a full-page database version is its data: the service asks for full access ("Full access is required to restore this database.")
  if (page.type === 'collection_view_page' && databases[page.id]?.owned) {
    const problem = databaseRestoreProblem(page.id, uid);
    if (problem) throw new VersionError(problem, 403);
  }
  const txOpts = { userInitiated: true, ...(opts.source ? { source: opts.source } : {}) };
  const now = Date.now();
  snapshotIfChanged(page.id, [uid], now - 1);
  const previousVersionId = latestSnapshotRow(page.id)?.id ?? null;
  // decided on today's state (access, locks) before anything changes
  const plan = databaseRestorePlan(page.id, databases, uid, opts.restoreDatabases !== false);
  const ops = restoreOps(page.id, (snap.data?.blocks ?? []) as BlockRecord[], uid, now);
  const changes = applyTransactions(uid, [{ id: newId(), spaceId: page.space_id, debug: { userAction: 'restoreVersion' }, operations: ops }], opts.clientId, txOpts);
  // databases: each in its own transaction, so one the person can't restore leaves the rest of the restore intact
  let unchanged = 0;
  for (const item of plan) {
    const d = databases[item.blockId];
    if (!d || item.status === 'removed') continue;
    if (item.status === 'unchanged') {
      if (item.reason) unchanged++;
      continue;
    }
    try {
      const dbOps = databaseRestoreOps(d, uid, now, item.status === 'views_only', snap.createdTime);
      if (dbOps.length) changes.push(...applyTransactions(uid, [{ id: newId(), spaceId: page.space_id, debug: { userAction: 'restoreVersion.database' }, operations: dbOps }], opts.clientId, txOpts));
    } catch {
      unchanged++;
    }
  }
  takeSnapshot(page.id, [uid], now + 1);
  return { pageId: page.id, changes, databasesUnchanged: unchanged, previousVersionId };
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * Line diff of two texts (a version's Markdown against another or today's page): changed lines prefixed "- " / "+ ",
 * `context` unchanged lines around each change prefixed "  ", longer unchanged stretches folded into "…". Empty when
 * the texts are equal.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (!x.length && !y.length) return '';
  const lines: { op: ' ' | '-' | '+'; text: string }[] = a.slice(0, head).map((text) => ({ op: ' ', text }));
  if ((x.length + 1) * (y.length + 1) > MAX_DIFF_CELLS) {
    // too large to align line by line: show the changed stretch as removed and added
    lines.push(...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text })));
  } else {
    // longest common subsequence, filled from the end so the walk below goes forward
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { lines.push({ op: ' ', text: x[i] }); i++; j++; }
      else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { lines.push({ op: '-', text: x[i] }); i++; }
      else { lines.push({ op: '+', text: y[j] }); j++; }
    }
  }
  lines.push(...a.slice(a.length - tail).map((text) => ({ op: ' ' as const, text })));
  const keep = lines.map(() => false);
  lines.forEach((l, k) => {
    if (l.op === ' ') return;
    for (let c = Math.max(0, k - context); c <= Math.min(lines.length - 1, k + context); c++) keep[c] = true;
  });
  const out: string[] = [];
  lines.forEach((l, k) => {
    if (keep[k]) out.push(`${l.op} ${l.text}`);
    else if (out[out.length - 1] !== '…') out.push('…');
  });
  return out.join('\n');
}

/** Comparable content fingerprint of a serialized page (ignores versions/edit stamps); databases count with their
 *  properties, records' property values and views . */
export function contentKey(data: { blocks: BlockRecord[]; databases?: Record<string, DatabaseSnapshot> }): string {
  const strip = (r: any) => {
    const { version: _v, last_edited_time: _t, last_edited_by_id: _u, last_edited_by_table: _ut, discussions: _d, applied_tx_ids: _a, ...rest } = r ?? {};
    return rest;
  };
  const dbs = Object.values(data.databases ?? {}).map((d) => ({
    blockId: d.blockId, collection: d.collection ? strip(d.collection) : null, views: d.views.map(strip),
    rows: (d.rows ?? []).map((r) => [r.id, r.properties ?? {}]),
  }));
  return JSON.stringify([data.blocks.map(strip), dbs]);
}

export function latestSnapshotRow(pageId: string): { id: string; created_time: number; data: string } | undefined {
  return db.prepare('SELECT id, created_time, data FROM snapshots WHERE page_id = ? ORDER BY created_time DESC LIMIT 1').get(pageId) as any;
}

/** Snapshot the page unless its content equals the latest snapshot. Returns true if a snapshot was taken. */
export function snapshotIfChanged(pageId: string, authors: string[], now = Date.now()): boolean {
  const page = getRecord<BlockRecord>('block', pageId);
  if (!page) return false;
  const last = latestSnapshotRow(pageId);
  if (last) {
    try {
      if (contentKey(JSON.parse(last.data)) === contentKey(serializePage(pageId))) return false;
    } catch {
      /* corrupt row: take a fresh snapshot */
    }
  }
  takeSnapshot(pageId, authors.length ? authors : [page.last_edited_by_id ?? page.created_by_id], now);
  return true;
}


/** Restore a snapshot into the live page (page content + metadata; permissions/comments/location stay). */
function restoreOps(pageId: string, blocks: BlockRecord[], uid: string, now: number) {
  const ops: any[] = [];
  const current = getRecord<BlockRecord>('block', pageId)!;
  const snapIds = new Set(blocks.map((b) => b.id));
  const ptr = (id: string) => ({ table: 'block', id, spaceId: current.space_id });
  for (const b of blocks) {
    const { version: _v, ...rest } = b as any;
    if (b.id === pageId) {
      ops.push({
        pointer: ptr(b.id), path: [], command: 'set',
        args: {
          ...rest,
          // a database row page: restricted values the restorer can't edit (or see) keep today's value 
          ...(current.parent_table === 'collection' ? { properties: restorableProperties(current, (rest as any).properties, uid) } : {}),
          alive: current.alive,
          parent_id: current.parent_id, parent_table: current.parent_table,
          permissions: current.permissions, discussions: current.discussions,
          last_edited_time: now, last_edited_by_id: uid, last_edited_by_table: 'lit_user',
          // a full-page database keeps today's lock state 
          ...(current.type === 'collection_view_page' ? { format: { ...((rest as any).format ?? {}), block_locked: (current.format as any)?.block_locked, block_locked_by: (current.format as any)?.block_locked_by } } : {}),
        },
      });
      continue;
    }
    const live = getRecord<BlockRecord>('block', b.id);
    if (PAGE_TYPES.has(b.type)) {
      // nested pages keep their own content/history; only bring them back under this page (not ones restricted from
      // the restorer: they stay as they are)
      if (live && blockRole(live.id, uid) === 'none') continue;
      if (live) ops.push({ pointer: ptr(b.id), path: [], command: 'update', args: { alive: true, parent_id: b.parent_id, parent_table: b.parent_table } });
      else ops.push({ pointer: ptr(b.id), path: [], command: 'set', args: { ...rest, alive: true } });
      continue;
    }
    // a locked database block is left exactly as it is (its lock freezes it; the restore reports it unchanged)
    if (live && isDatabaseLocked(live) && (live.type === 'collection_view' || live.type === 'collection_view_page')) continue;
    // a database keeps today's lock: restoring a version never unlocks (or locks) it 
    const lock = (b.type === 'collection_view' || b.type === 'collection_view_page') && live
      ? { format: { ...((rest as any).format ?? {}), block_locked: (live.format as any)?.block_locked, block_locked_by: (live.format as any)?.block_locked_by } }
      : {};
    ops.push({
      pointer: ptr(b.id), path: [], command: 'set',
      args: { ...rest, alive: true, discussions: live?.discussions ?? (rest as any).discussions, ...lock },
    });
  }
  // blocks added after this version are removed (subpages go to Trash, as expected restore)
  const live = serializePage(pageId).blocks;
  for (const b of live) {
    if (b.id === pageId || snapIds.has(b.id)) continue;
    if (isDatabaseLocked(b) && (b.type === 'collection_view' || b.type === 'collection_view_page')) continue; // locked: stays
    if (PAGE_TYPES.has(b.type) && blockRole(b.id, uid) === 'none') continue; // a sub-page restricted from the restorer
    ops.push({
      pointer: ptr(b.id), path: [], command: 'update',
      args: PAGE_TYPES.has(b.type) ? { alive: false, deleted_time: now, deleted_by_id: uid } : { alive: false },
    });
  }
  return ops;
}

// ---------------------------------------------------------------- databases in a version 
// Restoring brings back a database's properties (data source: schema, name, icon, description), its records and their
// property values (records added since that the restorer can edit go to Trash, records deleted since come back) and
// its views — never the records' page content ("To restore database page content, restore an earlier version
// for each page"). Full access to the database is required and a locked database is left as it is; on a page with
// inline databases the person chooses "Also restore databases on this page". Linked databases (data source elsewhere)
// only get their views back.

export type DatabaseRestoreStatus = 'restored' | 'unchanged' | 'removed' | 'views_only';

/** Can `uid` restore the data of database block `blockId` (full access, not locked)? */
export function databaseRestoreProblem(blockId: string, uid: string): string | null {
  const block = getRecord<BlockRecord>('block', blockId);
  if (!block || block.alive === false) return null; // comes back with the page's blocks
  if (blockRole(block.id, uid) !== 'editor') return 'Full access is required to restore this database.';
  if (isDatabaseLocked(block)) return 'This database is locked. Unlock it to change its views and properties.';
  return null;
}

/** Operations that put database `d` back the way it was (data source, records, views). */
function databaseRestoreOps(d: DatabaseSnapshot, uid: string, now: number, viewsOnly: boolean, versionTime: number): any[] {
  const ops: any[] = [];
  const space = getRecord<BlockRecord>('block', d.blockId)?.space_id;
  const ptr = (table: string, id: string) => ({ table, id, spaceId: space });
  for (const v of d.views) {
    const { version: _v, ...rest } = v as any;
    ops.push({ pointer: ptr('collection_view', v.id), path: [], command: 'set', args: { ...rest, alive: true } });
  }
  if (viewsOnly || !d.owned || !d.collection) return ops;
  const live = getRecord<CollectionRecord>('collection', d.collection.id);
  const { version: _cv, ...col } = d.collection as any;
  // server-kept fields stay as they are now: page-level access rules, property access rules (restoring a
  // previous version keeps the current rules"), the sprint automation's owner; properties added since go to Deleted
  // properties (restorable) instead of vanishing with their values
  ops.push({ pointer: ptr('collection', d.collection.id), path: [], command: 'set', args: { ...col, ...(live ? keptCollectionFields(col, live, now) : {}), alive: true } });
  const snapRows = new Map((d.rows ?? []).map((r) => [r.id, r]));
  for (const r of d.rows ?? []) {
    const cur = getRecord<BlockRecord>('block', r.id);
    if (cur && cur.parent_id !== d.collection.id) continue; // moved to another database since: leave it there
    // values of properties the version didn't have yet stay (those properties become deleted ones, restorable)
    const kept = Object.fromEntries(Object.entries(cur?.properties ?? {}).filter(([k]) => !d.collection!.schema[k]));
    if (cur) ops.push({ pointer: ptr('block', r.id), path: [], command: 'update', args: { properties: { ...kept, ...(r.properties ?? {}) }, alive: true, last_edited_time: now, last_edited_by_id: uid } });
    else {
      const { version: _rv, ...row } = r as any;
      ops.push({ pointer: ptr('block', r.id), path: [], command: 'set', args: { ...row, alive: true, content: [] } });
    }
  }
  // records that weren't in this version (that the restorer can edit) go to Trash; a version that stored only the
  // first 1000 records can only tell records created after it
  const capped = (d.rows?.length ?? 0) >= 1000;
  for (const r of childrenOf<BlockRecord>('block', d.collection.id)) {
    if (r.parent_table !== 'collection' || !r.alive || r.is_template || snapRows.has(r.id)) continue;
    if (capped && (r.created_time ?? 0) <= versionTime) continue;
    if (!['editor', 'read_and_write'].includes(blockRole(r.id, uid))) continue;
    ops.push({ pointer: ptr('block', r.id), path: [], command: 'update', args: { alive: false, deleted_time: now, deleted_by_id: uid } });
  }
  return ops;
}

/** Fields of a restored data source that stay as they are today (see databaseRestoreOps). */
function keptCollectionFields(col: any, live: CollectionRecord, now: number): Record<string, unknown> {
  const liveDeleted = deletedSchemaOf(live) ?? {};
  const schema: Record<string, any> = {};
  for (const [pid, p] of Object.entries((col.schema ?? {}) as Record<string, any>)) {
    const cur = live.schema[pid] ?? liveDeleted[pid];
    if (!cur) { schema[pid] = p; continue; } // deleted for good since: comes back as the version had it
    const { property_permissions: _rule, ...rest } = p ?? {};
    schema[pid] = cur.property_permissions ? { ...rest, property_permissions: cur.property_permissions } : rest;
  }
  const deleted: Record<string, any> = {};
  for (const [pid, p] of Object.entries(liveDeleted)) if (p && !schema[pid]) deleted[pid] = p;
  for (const [pid, p] of Object.entries(live.schema)) if (!schema[pid]) deleted[pid] = { ...p, deleted_time: now };
  const liveSprints = (live.format as any)?.sprint_settings;
  const format = { ...(col.format ?? {}) };
  if (liveSprints) format.sprint_settings = liveSprints;
  else delete format.sprint_settings;
  return { permission_rules: (live as any).permission_rules, schema, deleted_schema: deleted, format };
}

/** What restoring `databases` does to each database (restore panel "Will be restored / unchanged / removed"). */
export function databaseRestorePlan(pageId: string, databases: Record<string, DatabaseSnapshot>, uid: string, restoreInline: boolean) {
  const plan: { blockId: string; name: string; status: DatabaseRestoreStatus; reason?: string; owned: boolean; rows: number; inline: boolean }[] = [];
  for (const d of Object.values(databases)) {
    const inline = d.blockId !== pageId;
    const name = toPlainText((d.collection ?? getRecord<CollectionRecord>('collection', d.collectionId ?? ''))?.name) || 'Untitled';
    let status: DatabaseRestoreStatus = !d.owned ? 'views_only' : inline && !restoreInline ? 'unchanged' : 'restored';
    let reason: string | undefined;
    if (status === 'restored') {
      const problem = databaseRestoreProblem(d.blockId, uid);
      if (problem) { status = 'unchanged'; reason = problem; }
    }
    plan.push({ blockId: d.blockId, name, status, reason, owned: d.owned, rows: d.rows?.length ?? 0, inline });
  }
  // inline databases added after this version are taken off the page with the rest of the new blocks
  for (const b of serializePage(pageId).blocks) {
    if (b.type !== 'collection_view' || databases[b.id]) continue;
    const col = b.collection_id ? getRecord<CollectionRecord>('collection', b.collection_id) : undefined;
    plan.push({ blockId: b.id, name: toPlainText(col?.name) || 'Untitled', status: 'removed', owned: col?.parent_id === b.id, rows: 0, inline: true });
  }
  return plan;
}

