// update_page replace_content / replace_content_range keep sub-pages and databases (also those nested in a removed
// toggle), and search leaves out rows of a trashed database (agent search and Quick Find).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-ai-replace-test-'));

let db: typeof import('../src/db.ts');
let registry: typeof import('../src/ai/tools/registry.ts');
let records: typeof import('../src/records.ts');
let OpsBuilder: typeof import('../src/content/spec.ts').OpsBuilder;
let H: Record<string, (ctx: any, body: any) => any>;
let A = '';
let spaceId = '';

const env = (userId: string) => ({
  userId, spaceId, threadId: null, turnId: `t-${Math.random().toString(36).slice(2)}`, currentPageId: null, approvalMode: 'skip_all', memories: true,
  cite: () => 1, step: () => {}, touched: () => {}, approve: async () => 'accept',
}) as any;
const tool = (name: string, input: Record<string, unknown>) => registry.runTool(env(A), name, input, `s-${Math.random().toString(36).slice(2)}`);
const idIn = (text: string) => /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(text)![1];
const block = (id: string) => db.getRecord<any>('block', id);

async function page(title: string, content = ''): Promise<string> {
  const r = await tool('create_pages', { pages: [{ title, content }] });
  return idIn(r.content);
}

/** A toggle holding a sub-page, appended to `pageId` (the agent tools can't nest pages in blocks). */
function addToggleWithSubPage(pageId: string, subTitle: string): { toggle: string; sub: string } {
  const b = new OpsBuilder(spaceId, A);
  const toggle = b.block({ type: 'toggle', text: 'More', children: [{ type: 'page', text: subTitle }] }, pageId, 'block');
  b.ops.push({ pointer: { table: 'block', id: pageId, spaceId }, path: ['content'], command: 'listAfter', args: { id: toggle } });
  records.applyTransactions(A, [{ id: crypto.randomUUID(), spaceId, operations: b.ops }], undefined, { client: true });
  return { toggle, sub: block(toggle).content[0] };
}

beforeAll(async () => {
  const { newId } = await import('@nc/shared/ids.ts');
  const seed = await import('../src/seed.ts');
  db = await import('../src/db.ts');
  registry = await import('../src/ai/tools/registry.ts');
  records = await import('../src/records.ts');
  ({ OpsBuilder } = await import('../src/content/spec.ts'));
  await import('../src/app.ts');
  H = (await import('../src/api/handlers.ts')).handlers as any;
  A = newId();
  seed.createUser(A, 'a@replace.dev', 'Ann');
  spaceId = seed.createWorkspace(A, 'Replace').space.id;
});

describe('update_page keeps sub-pages', () => {
  it('replace_content keeps sub-pages and databases after the new content', async () => {
    const hub = await page('Hub', 'Old intro');
    const sub = idIn((await tool('create_pages', { parent: { type: 'page', id: hub }, pages: [{ title: 'Area' }] })).content);
    const dbId = idIn((await tool('create_database', { parent: { type: 'page', id: hub }, title: 'Projects', properties: [{ name: 'Status', type: 'text' }] })).content);
    const r = await tool('update_page', { page_id: hub, command: 'replace_content', new_str: 'New intro' });
    expect(r.content).toContain('Kept 2 sub-page(s)');
    expect(block(sub).alive).toBe(true);
    expect(block(dbId).alive).toBe(true);
    const content = block(hub).content.filter((id: string) => block(id).alive !== false);
    expect(content.slice(-2)).toEqual([sub, dbId]);
    expect(content.map((id: string) => block(id).type)).toEqual(['text', 'page', 'collection_view_page']);
  });

  it('moves a sub-page out of a removed toggle onto the page', async () => {
    const hub = await page('Toggle hub', 'Intro');
    const { toggle, sub } = addToggleWithSubPage(hub, 'Nested');
    await tool('update_page', { page_id: hub, command: 'replace_content_range', selection_with_ellipsis: 'More', new_str: 'Replaced' });
    expect(block(toggle).alive).toBe(false);
    expect(block(sub)).toMatchObject({ alive: true, parent_id: hub, parent_table: 'block' });
    const content = block(hub).content.filter((id: string) => block(id).alive !== false);
    expect(content[content.length - 1]).toBe(sub);
    expect(block(toggle).content ?? []).not.toContain(sub);
  });
});

describe('search hides trashed content', () => {
  it('leaves out rows of a trashed database', async () => {
    const dbId = idIn((await tool('create_database', { title: 'Ledger', properties: [{ name: 'Status', type: 'text' }] })).content);
    const row = idIn((await tool('create_pages', { parent: { type: 'database', id: dbId }, pages: [{ title: 'Zyxwvut entry' }] })).content);
    expect((await tool('search_workspace', { query: 'Zyxwvut' })).content).toContain(row);
    expect(H.searchWorkspace({ userId: A }, { spaceId, query: 'Zyxwvut' }).results.map((x: any) => x.id)).toContain(row);
    await tool('delete_pages', { page_ids: [dbId] });
    expect((await tool('search_workspace', { query: 'Zyxwvut' })).content).not.toContain(row);
    expect(H.searchWorkspace({ userId: A }, { spaceId, query: 'Zyxwvut' }).results.map((x: any) => x.id)).not.toContain(row);
  });
});
