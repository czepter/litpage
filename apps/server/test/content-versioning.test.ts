// Partial edits and versions through the agent tools (AI chat, Custom Agents, MCP): replace_text changes words inside
// blocks and keeps the blocks, update_rows changes many database rows at once (set, add / remove list items), every
// edit saves the state before it as a version, view_version_history compares versions and manage_versions saves,
// names and restores them — with the same access checks as the Version history panel.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-versioning-test-'));

let db: typeof import('../src/db.ts');
let registry: typeof import('../src/ai/tools/registry.ts');
let history: typeof import('../src/history.ts');
let versions: typeof import('../src/versions.ts');
let mcp: typeof import('../src/ai/litMcp.ts');
let A = '';
let B = '';
let C = '';
let spaceId = '';
let pageId = '';

function env(userId: string) {
  return {
    userId, spaceId, threadId: `thread-${userId}`, turnId: `turn-${Math.random().toString(36).slice(2)}`, currentPageId: null,
    approvalMode: 'skip_all', memories: false, cite: () => 1, step: () => {}, touched: () => {}, approve: async () => 'accept',
  } as unknown as import('../src/ai/tools/types.ts').AgentEnv;
}
const run = (userId: string, tool: string, input: Record<string, unknown>) => registry.runTool(env(userId), tool, input, 's');
const block = (id: string) => db.getRecord<any>('block', id);
const kids = (id: string) => (block(id).content as string[]).map(block).filter((b) => b.alive !== false);
const versionIdIn = (text: string) => /version_id ([0-9a-f-]{36})/.exec(text)?.[1];

beforeAll(async () => {
  const { newId } = await import('@nc/shared/ids.ts');
  const seed = await import('../src/seed.ts');
  db = await import('../src/db.ts');
  registry = await import('../src/ai/tools/registry.ts');
  history = await import('../src/history.ts');
  versions = await import('../src/versions.ts');
  mcp = await import('../src/ai/litMcp.ts');
  A = newId();
  B = newId();
  C = newId();
  seed.createUser(A, 'ada@versions.dev', 'Ada');
  seed.createUser(B, 'bo@versions.dev', 'Bo');
  seed.createUser(C, 'cy@versions.dev', 'Cy');
  spaceId = seed.createWorkspace(A, 'Versions Lab').space.id;
  seed.addMember(spaceId, B, 'member');
  seed.addMember(spaceId, C, 'member');
  pageId = seed.createPage({
    spaceId, userId: A, parentId: spaceId, parentTable: 'space', title: 'Release notes',
    content: [
      { type: 'text', title: [['Ships on '], ['Friday', [['b']]], [' to all teams.']] },
      { type: 'bulleted_list', title: [['Owner: Friday crew']] },
    ],
    permissions: [{ type: 'user_permission', role: 'editor', user_id: A }, { type: 'user_permission', role: 'read_and_write', user_id: B }, { type: 'user_permission', role: 'reader', user_id: C }],
  }).id;
});

describe('replace_text', () => {
  it('replaces words inside a block and keeps the block, its formatting and comments', async () => {
    const [first] = kids(pageId);
    db.putRecord('block', { ...first, discussions: ['disc-1'] });
    const r = await run(B, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Ships on Friday', new_str: 'Ships on Monday' });
    expect(r.isError).toBeFalsy();
    const after = kids(pageId)[0];
    expect(after.id).toBe(first.id);
    expect(after.discussions).toEqual(['disc-1']);
    // only the differing part is rewritten: the bold day stays bold
    expect(after.properties.title).toEqual([['Ships on '], ['Monday', [['b']]], [' to all teams.']]);
  });

  it('refuses ambiguous or missing text, and replaces every occurrence with replace_all', async () => {
    await run(B, 'update_page', { page_id: pageId, command: 'append_content', new_str: 'Questions to the Friday crew.' });
    const amb = await run(B, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Friday', new_str: 'Weekend' });
    expect(amb.isError).toBe(true);
    expect(amb.content).toMatch(/appears 2 times/);
    const miss = await run(B, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Saturday', new_str: 'x' });
    expect(miss.isError).toBe(true);
    const all = await run(B, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Friday crew', new_str: 'release crew', replace_all: true });
    expect(all.isError).toBeFalsy();
    expect(all.content).toMatch(/2 times/);
    const text = kids(pageId).map((b) => b.properties.title.map((d: any) => d[0]).join('')).join('\n');
    expect(text).not.toContain('Friday');
    expect(text).toContain('Owner: release crew');
  });

  it('is refused for people who can only view the page', async () => {
    const r = await run(C, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Monday', new_str: 'Tuesday' });
    expect(r.isError).toBe(true);
    expect(kids(pageId)[0].properties.title.map((d: any) => d[0]).join('')).toBe('Ships on Monday to all teams.');
  });
});

describe('versions', () => {
  it('saves the state before every edit; compares and restores it', async () => {
    const r = await run(B, 'update_page', { page_id: pageId, command: 'replace_text', old_str: 'Ships on Monday', new_str: 'Ships next quarter' });
    expect(r.isError).toBeFalsy();
    const before = versionIdIn(r.content)!;
    expect(before).toBeTruthy();
    const textOf = (blocks: any[]) => blocks.map((b) => (b.properties?.title ?? []).map((d: any) => d[0]).join('')).join('\n');
    expect(textOf(history.getSnapshot(before)!.data.blocks)).toContain('Ships on Monday');
    // the edit itself is the newest version
    const [latest] = history.listSnapshots(pageId, 1);
    expect(latest.id).not.toBe(before);
    expect(textOf(history.getSnapshot(latest.id)!.data.blocks)).toContain('Ships next quarter');

    const diff = await run(B, 'view_version_history', { page_id: pageId, version_id: before, compare_with: 'current' });
    expect(diff.isError).toBeFalsy();
    expect(diff.content).toMatch(/^- Ships on \*\*Monday\*\* to all teams\./m);
    expect(diff.content).toMatch(/^\+ Ships next quarter/m);

    const restore = await run(B, 'manage_versions', { page_id: pageId, action: 'restore', version_id: before });
    expect(restore.isError).toBeFalsy();
    expect(kids(pageId)[0].properties.title.map((d: any) => d[0]).join('')).toBe('Ships on Monday to all teams.');
    // the restore can be undone by restoring the version saved right before it
    const undoTo = /saved as version_id ([0-9a-f-]{36})/.exec(restore.content)![1];
    expect((await run(B, 'manage_versions', { page_id: pageId, action: 'restore', version_id: undoTo })).isError).toBeFalsy();
    expect(kids(pageId)[0].properties.title.map((d: any) => d[0]).join('')).toBe('Ships next quarter to all teams.');
  });

  it('saves a named version and lists it', async () => {
    const r = await run(A, 'manage_versions', { page_id: pageId, action: 'save', name: 'Before rewrite' });
    expect(r.isError).toBeFalsy();
    const id = versionIdIn(r.content)!;
    const list = await run(A, 'view_version_history', { page_id: pageId });
    expect(list.content).toContain(`version_id ${id}: “Before rewrite”`);
    // names are per person, like bookmarks in the panel
    expect((await run(B, 'view_version_history', { page_id: pageId })).content).not.toContain('Before rewrite');
  });

  it('needs edit access, like Version history', async () => {
    const [snap] = history.listSnapshots(pageId, 1);
    const r = await run(C, 'manage_versions', { page_id: pageId, action: 'restore', version_id: snap.id });
    expect(r.isError).toBe(true);
    expect((await run(C, 'manage_versions', { page_id: pageId, action: 'save' })).isError).toBe(true);
    // a version id of another page is not this page's
    const other = await run(A, 'create_pages', { pages: [{ title: 'Other', content: 'x' }] });
    const otherId = /page_id: ([0-9a-f-]{36})/.exec(other.content)![1];
    history.takeSnapshot(otherId, [A]);
    const [foreign] = history.listSnapshots(otherId, 1);
    expect((await run(A, 'manage_versions', { page_id: pageId, action: 'restore', version_id: foreign.id })).isError).toBe(true);
  });
});

describe('update_rows', () => {
  let dbId = '';
  const col = () => db.getRecord<any>('collection', block(dbId).collection_id);
  const pid = (name: string) => Object.keys(col().schema).find((k) => col().schema[k].name === name)!;
  const rows = () => db.childrenOf<any>('block', col().id).filter((r) => r.parent_table === 'collection' && r.alive !== false);
  const row = (title: string) => rows().find((r) => r.properties.title?.[0]?.[0] === title);

  beforeAll(async () => {
    const r = await run(A, 'create_database', {
      title: 'Backlog',
      properties: [{ name: 'Name', type: 'title' }, { name: 'Status', type: 'select', options: ['Todo', 'Doing', 'Done'] }, { name: 'Tags', type: 'multi_select', options: ['UI', 'API'] }, { name: 'Owner', type: 'person' }],
      rows: [{ Name: 'Login', Status: 'Todo', Tags: ['UI'] }, { Name: 'Search', Status: 'Todo', Tags: ['UI', 'API'] }, { Name: 'Export', Status: 'Done', Tags: ['API'] }],
    });
    dbId = /database_id: ([0-9a-f-]{36})/.exec(r.content)![1];
  });

  it('sets values on every row matching the filters and saves the database as a version first', async () => {
    const r = await run(A, 'update_rows', { database_id: dbId, filters: [{ property: 'Status', operator: 'equals', value: 'Todo' }], properties: { Status: 'Doing', Owner: 'Bo' } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Updated 2 rows/);
    expect(row('Login').properties[pid('Status')]).toEqual([['Doing']]);
    expect(row('Search').properties[pid('Owner')]).toEqual([['‣', [['u', B]]]]);
    expect(row('Export').properties[pid('Status')]).toEqual([['Done']]);
    const before = history.getSnapshot(versionIdIn(r.content)!)!;
    const saved = Object.values<any>(before.data.databases)[0].rows.find((x: any) => x.id === row('Login').id);
    expect(saved.properties[pid('Status')]).toEqual([['Todo']]);
  });

  it('adds and removes single list values without touching the others', async () => {
    const r = await run(A, 'update_rows', { database_id: dbId, all: true, add_values: { Tags: ['Urgent'] }, remove_values: { Tags: ['ui'] } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Updated 3 rows/);
    expect(row('Login').properties[pid('Tags')]).toEqual([['Urgent']]);
    expect(row('Search').properties[pid('Tags')]).toEqual([['API,Urgent']]);
    expect(row('Export').properties[pid('Tags')]).toEqual([['API,Urgent']]);
    // a new option is created once, not once per row
    expect(col().schema[pid('Tags')].options.filter((o: any) => o.value === 'Urgent')).toHaveLength(1);
    const people = await run(A, 'update_rows', { database_id: dbId, page_ids: [row('Login').id], remove_values: { Owner: ['Bo'] }, add_values: { Owner: ['Ada'] } });
    expect(people.isError).toBeFalsy();
    expect(row('Login').properties[pid('Owner')]).toEqual([['‣', [['u', A]]]]);
  });

  it('refuses unclear or impossible changes', async () => {
    expect((await run(A, 'update_rows', { database_id: dbId, properties: { Status: 'Done' } })).content).toMatch(/Say which rows/);
    expect((await run(A, 'update_rows', { database_id: dbId, page_ids: [pageId], properties: { Status: 'Done' } })).content).toMatch(/Not rows of/);
    expect((await run(A, 'update_rows', { database_id: dbId, all: true, add_values: { Status: ['Done'] } })).content).toMatch(/isn’t a multi-select/);
    expect((await run(A, 'update_rows', { database_id: dbId, all: true, properties: { Tags: 'UI' }, add_values: { Tags: ['API'] } })).isError).toBe(true);
    // a member without access to the database can't see (or change) its rows
    expect((await run(C, 'update_rows', { database_id: dbId, all: true, properties: { Status: 'Done' } })).isError).toBe(true);
    expect(row('Export').properties[pid('Status')]).toEqual([['Done']]);
    expect(row('Login').properties[pid('Status')]).toEqual([['Doing']]);
  });
});

describe('lineDiff', () => {
  it('shows changed lines with context and folds the rest', () => {
    const a = ['# Title', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
    const b = ['# Title', 'one', 'two', 'three', 'four', 'five', 'SIX', 'seven', 'eight'].join('\n');
    expect(versions.lineDiff(a, b, 1)).toBe(['…', '  five', '- six', '+ SIX', '  seven', '+ eight'].join('\n'));
    expect(versions.lineDiff(a, a)).toBe('');
  });
});

describe('MCP', () => {
  it('offers the version and bulk tools, marking restore as destructive', async () => {
    const { token } = mcp.createToken(B, spaceId, 'Claude Desktop');
    const list = await mcp.handleMcpHttp(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list.body as any).result.tools as { name: string; annotations: Record<string, boolean> }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining(['lit-get-versions', 'lit-update-rows', 'lit-manage-versions']));
    expect(byName.get('lit-manage-versions')!.annotations.destructiveHint).toBe(true);
    expect(byName.get('lit-get-versions')!.annotations.readOnlyHint).toBe(true);
    const call = await mcp.handleMcpHttp(`Bearer ${token}`, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lit-get-versions', arguments: { page_id: pageId } } });
    expect((call.body as any).result.content[0].text).toMatch(/Versions of “Release notes”/);
  });

  it('edits several passages in one call without replacing the page', async () => {
    const { token } = mcp.createToken(B, spaceId, 'Claude Desktop');
    const ids = kids(pageId).map((b) => b.id);
    const call = (args: Record<string, unknown>) => mcp.handleMcpHttp(`Bearer ${token}`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lit-update-page', arguments: args } });
    const r = await call({ page_id: pageId, command: 'replace_text', content_updates: [{ old_str: 'next quarter', new_str: 'in spring' }, { old_str: 'Owner: release crew', new_str: 'Owner: Ada' }] });
    expect((r.body as any).result.isError).toBeFalsy();
    expect(kids(pageId).map((b) => b.id)).toEqual(ids);
    const text = kids(pageId).map((b) => b.properties.title.map((d: any) => d[0]).join('')).join('\n');
    expect(text).toContain('Ships in spring to all teams.');
    expect(text).toContain('Owner: Ada');
    // all or nothing
    const bad = await call({ page_id: pageId, command: 'replace_text', content_updates: [{ old_str: 'in spring', new_str: 'in summer' }, { old_str: 'missing text', new_str: 'x' }] });
    expect((bad.body as any).result.isError).toBe(true);
    expect((bad.body as any).result.content[0].text).toMatch(/Edit 2/);
    expect(kids(pageId)[0].properties.title.map((d: any) => d[0]).join('')).toBe('Ships in spring to all teams.');
  });
});
