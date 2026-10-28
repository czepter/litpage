// list_trash / restore_pages (lit-list-trash / lit-restore-pages over MCP): list what is in Trash and bring pages,
// sub-pages, databases and rows back to where they were.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-ai-trash-test-'));

let db: typeof import('../src/db.ts');
let registry: typeof import('../src/ai/tools/registry.ts');
let litMcp: typeof import('../src/ai/litMcp.ts');
let A = '';
let B = '';
let spaceId = '';

const env = (userId: string) => ({
  userId, spaceId, threadId: null, turnId: `t-${Math.random().toString(36).slice(2)}`, currentPageId: null, approvalMode: 'skip_all', memories: true,
  cite: () => 1, step: () => {}, touched: () => {}, approve: async () => 'accept',
}) as any;
const toolAs = (userId: string, name: string, input: Record<string, unknown>) => registry.runTool(env(userId), name, input, `s-${Math.random().toString(36).slice(2)}`);
const tool = (name: string, input: Record<string, unknown>) => toolAs(A, name, input);
const idIn = (text: string) => /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(text)![1];
const block = (id: string) => db.getRecord<any>('block', id);
const privatePages = (userId: string): string[] => {
  for (const id of db.getRecord<any>('user_root', userId)?.space_views ?? []) {
    const sv = db.getRecord<any>('space_view', id);
    if (sv?.space_id === spaceId) return sv.private_pages ?? [];
  }
  return [];
};

beforeAll(async () => {
  const { newId } = await import('@nc/shared/ids.ts');
  const seed = await import('../src/seed.ts');
  db = await import('../src/db.ts');
  registry = await import('../src/ai/tools/registry.ts');
  litMcp = await import('../src/ai/litMcp.ts');
  await import('../src/app.ts');
  A = newId();
  B = newId();
  seed.createUser(A, 'a@trash.dev', 'Ann');
  seed.createUser(B, 'b@trash.dev', 'Ben');
  spaceId = seed.createWorkspace(A, 'Trash').space.id;
});

describe('list_trash / restore_pages', () => {
  it('lists only the top-most deleted item and restores it with its sub-pages', async () => {
    const hub = idIn((await tool('create_pages', { pages: [{ title: 'Hub' }] })).content);
    const sub = idIn((await tool('create_pages', { parent: { type: 'page', id: hub }, pages: [{ title: 'Area' }] })).content);
    await tool('delete_pages', { page_ids: [sub] });
    await tool('delete_pages', { page_ids: [hub] });
    const list = (await tool('list_trash', {})).content;
    expect(list).toContain(hub);
    expect(list).not.toContain(sub);

    const r = await tool('restore_pages', { page_ids: [hub] });
    expect(r.isError).toBeFalsy();
    expect(block(hub).alive).toBe(true);
    expect(block(hub).deleted_time).toBeUndefined();
    expect(privatePages(A)).toContain(hub);
    // the sub-page was deleted on its own before: it stays in Trash, now listed
    expect((await tool('list_trash', {})).content).toContain(sub);
  });

  it('puts a restored sub-page back into its parent', async () => {
    const hub = idIn((await tool('create_pages', { pages: [{ title: 'Parent' }] })).content);
    const sub = idIn((await tool('create_pages', { parent: { type: 'page', id: hub }, pages: [{ title: 'Child' }] })).content);
    await tool('delete_pages', { page_ids: [sub] });
    expect(block(hub).content).not.toContain(sub);
    await tool('restore_pages', { page_ids: [sub] });
    expect(block(sub).alive).toBe(true);
    expect(block(hub).content).toContain(sub);
  });

  it('restores a database and refuses a row whose database is still in Trash', async () => {
    const dbId = idIn((await tool('create_database', { title: 'Lessons', properties: [{ name: 'Note', type: 'text' }] })).content);
    const row = idIn((await tool('create_pages', { parent: { type: 'database', id: dbId }, pages: [{ title: 'Lesson one' }] })).content);
    await tool('delete_pages', { page_ids: [row] });
    await tool('delete_pages', { page_ids: [dbId] });
    const refused = await tool('restore_pages', { page_ids: [row] });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain(dbId);
    const r = await tool('restore_pages', { page_ids: [dbId, row] });
    expect(r.isError).toBeFalsy();
    expect(block(dbId).alive).toBe(true);
    expect(block(row).alive).toBe(true);
    expect((await tool('query_database', { database_id: dbId })).content).toContain('Lesson one');
  });

  it('refuses pages that are not in Trash and pages the user cannot see', async () => {
    const live = idIn((await tool('create_pages', { pages: [{ title: 'Alive' }] })).content);
    expect((await tool('restore_pages', { page_ids: [live] })).content).toContain('isn’t in Trash');
    await tool('delete_pages', { page_ids: [live] });
    // a private page of Ann is no one else's to list or restore
    expect((await toolAs(B, 'list_trash', {})).content).not.toContain(live);
    expect((await toolAs(B, 'restore_pages', { page_ids: [live] })).isError).toBe(true);
    await tool('restore_pages', { page_ids: [live] });
    expect(block(live).alive).toBe(true);
  });

  it('is offered over MCP', () => {
    const names = litMcp.mcpToolList(spaceId).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['lit-list-trash', 'lit-restore-pages']));
  });
});
