// Library "All content" tab: getLibraryAllPages lists pages, databases and database rows the caller can open,
// newest edit first, without templates, other workspaces' pages or pages the caller has no access to.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-library-test-'));

let H: Record<string, (ctx: any, body: any) => any>;
let db: typeof import('../src/db.ts');
let newId: () => string;
const ids = {} as Record<string, string>;
const ctx = (userId: string | null) => ({ userId, ip: '127.0.0.1', setCookie: () => {} });
const call = async (user: string | null, name: string, body: any = {}) => H[name](ctx(user), body);
let clock = Date.now();
function block(id: string, type: string, parentId: string, parentTable: string, extra: Record<string, unknown> = {}) {
  clock += 1000;
  return { id, version: 1, type, parent_id: parentId, parent_table: parentTable, space_id: ids.space, alive: true, created_time: clock, created_by_id: ids.owner, last_edited_time: clock, last_edited_by_id: ids.owner, ...extra } as any;
}
const owner = () => [{ type: 'user_permission', role: 'editor', user_id: ids.owner }];

beforeAll(async () => {
  ({ newId } = await import('@nc/shared/ids.ts'));
  H = { ...(await import('../src/api/handlers.ts')).handlers, ...(await import('../src/api/extra.ts')).extraHandlers } as any;
  db = await import('../src/db.ts');
  const seed = await import('../src/seed.ts');
  for (const n of ['owner', 'member']) {
    ids[n] = newId();
    seed.createUser(ids[n], `${n}@lib.test`, n);
  }
  ids.space = seed.createWorkspace(ids.owner, 'Acme').space.id;
  seed.addMember(ids.space, ids.member, 'editor');
  for (const n of ['page', 'child', 'dbPage', 'row', 'template', 'trashed', 'private', 'collection']) ids[n] = newId();
  db.putRecord('block', block(ids.page, 'page', ids.space, 'space', { properties: { title: [['Roadmap']] }, content: [ids.child], permissions: [...owner(), { type: 'user_permission', role: 'reader', user_id: ids.member }] }));
  db.putRecord('block', block(ids.child, 'page', ids.page, 'block', { properties: { title: [['Q3']] } }));
  db.putRecord('block', block(ids.dbPage, 'collection_view_page', ids.space, 'space', { collection_id: ids.collection, permissions: owner() }));
  db.putRecord('collection', { id: ids.collection, version: 1, parent_id: ids.dbPage, parent_table: 'block', space_id: ids.space, alive: true, name: [['Tasks']], schema: {} } as any);
  db.putRecord('block', block(ids.row, 'page', ids.collection, 'collection', { properties: { title: [['Ship it']] } }));
  db.putRecord('block', block(ids.template, 'page', ids.collection, 'collection', { is_template: true }));
  db.putRecord('block', block(ids.trashed, 'page', ids.space, 'space', { alive: false, permissions: owner() }));
  db.putRecord('block', block(ids.private, 'page', ids.space, 'space', { permissions: owner() }));
});

describe('getLibraryAllPages', () => {
  it('lists pages, databases and rows, newest edit first, without templates or trashed pages', async () => {
    const r = await call(ids.owner, 'getLibraryAllPages', { spaceId: ids.space });
    const mine = new Set(Object.values(ids));
    expect(r.pageIds.filter((id: string) => mine.has(id))).toEqual([ids.private, ids.row, ids.dbPage, ids.child, ids.page]);
    expect(r.recordMap.collection[ids.collection]).toBeTruthy();
  });

  it('leaves out pages the caller cannot open', async () => {
    const r = await call(ids.member, 'getLibraryAllPages', { spaceId: ids.space });
    expect(r.pageIds).toContain(ids.page);
    expect(r.pageIds).toContain(ids.child);
    expect(r.pageIds).not.toContain(ids.private);
    expect(r.pageIds).not.toContain(ids.dbPage);
  });

  it('requires a signed-in user', async () => {
    await expect(call(null, 'getLibraryAllPages', { spaceId: ids.space })).rejects.toMatchObject({ status: 401 });
  });
});
