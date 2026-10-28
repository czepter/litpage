// Page-tree traversal helpers for server-side walkers (duplicate, export, AI context, snapshots, permanent delete).
// A block's `content` list is client-writable, so an id listed there is only a child when that block points back at
// the parent (parent_table 'block' + parent_id). Walkers must use these helpers instead of trusting `content`, or
// someone could list another workspace's block in their own page and have it copied / exported / summarized / deleted.
import type { BlockRecord, CollectionRecord } from '@nc/shared/records.ts';
import { getRecord } from './db.ts';

/** Real children of `b` in content order (alive ones unless `alive: false`). */
export function childBlocks(b: BlockRecord | undefined, opts: { alive?: boolean } = {}): BlockRecord[] {
  if (!b || !Array.isArray(b.content)) return [];
  const aliveOnly = opts.alive !== false;
  const out: BlockRecord[] = [];
  const seen = new Set<string>();
  for (const id of b.content) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const c = getRecord<BlockRecord>('block', id);
    if (!c || c.parent_table !== 'block' || c.parent_id !== b.id) continue;
    if (aliveOnly && c.alive === false) continue;
    out.push(c);
  }
  return out;
}

/** True when `childId` is a real child of `parent`. */
export function isChildOf(child: BlockRecord | undefined, parent: BlockRecord | undefined): boolean {
  return !!child && !!parent && child.parent_table === 'block' && child.parent_id === parent.id;
}

/** True when `b` or a page / database above it is in Trash: a row of a trashed database, a sub-page of a trashed page. */
export function inTrash(b: BlockRecord | undefined): boolean {
  let cur = b;
  for (let i = 0; i < 200 && cur; i++) {
    if (cur.alive === false) return true;
    if (cur.parent_table === 'block') cur = getRecord<BlockRecord>('block', cur.parent_id);
    else if (cur.parent_table === 'collection') {
      const col = getRecord<CollectionRecord>('collection', cur.parent_id);
      if (!col || col.alive === false) return true;
      cur = getRecord<BlockRecord>('block', col.parent_id);
    } else return false;
  }
  return false;
}
