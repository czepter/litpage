// Linked views: one page that shows several databases live (an overall roadmap over the teams' roadmaps), made by the
// agent / MCP tool create_linked_views and by the public API (/v1/views). The views point at their sources, store
// their filters and sorts the way the app does, and show only what the acting person may open.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-linked-views-test-'));

let db: typeof import('../src/db.ts');
let registry: typeof import('../src/ai/tools/registry.ts');
let litMcp: typeof import('../src/ai/litMcp.ts');
let shared: typeof import('@nc/shared/database/index.ts');
let queryctx: typeof import('../src/queryctx.ts');
let app: typeof import('../src/app.ts')['app'];
let newId: () => string;
let A = '';
let B = '';
let spaceId = '';
let home = '';
let token = '';
const dbs = {} as Record<string, { block: string; col: string }>;

const env = (userId: string) => ({
  userId, spaceId, threadId: null, turnId: `t-${Math.random().toString(36).slice(2)}`, currentPageId: null, approvalMode: 'skip_all', memories: true,
  cite: () => 1, step: () => {}, touched: () => {}, approve: async () => 'accept',
}) as any;
const tool = (e: any, name: string, input: Record<string, unknown>) => registry.runTool(e, name, input, `s-${Math.random().toString(36).slice(2)}`);
const rec = (table: string, id: string) => db.getRecord<any>(table as any, id);
const viewsOf = (blockId: string) => (rec('block', blockId).view_ids ?? []).map((id: string) => rec('collection_view', id));
/** Row titles a view shows to `userId` (the app's query engine with the view's saved filter and sorts). */
function shown(viewId: string, userId: string): string[] {
  const v = rec('collection_view', viewId);
  const ctx = queryctx.viewerQueryContext(userId);
  const col = ctx.getRecord!('collection', v.format.collection_pointer.id) as any;
  return shared.runQuery(ctx.rowsOf!(col.id), col, v, ctx).rows.map((r: any) => r.properties.title[0][0]);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await app.request(`/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'lit-version': '2026-10-01' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

/** A team roadmap: Name, Status (select), Quarter (select), Due (date) with rows. */
function roadmap(name: string, parent: string, rows: [string, string, string, string][], permissions?: any[]) {
  const now = Date.now();
  const block = newId();
  const col = newId();
  const view = newId();
  db.putRecord('block', {
    id: block, version: 1, type: 'collection_view', parent_id: parent, parent_table: 'block', space_id: spaceId, alive: true, collection_id: col, view_ids: [view],
    created_time: now, created_by_id: A, last_edited_time: now, last_edited_by_id: A, ...(permissions ? { permissions, permissions_unlinked: true } : {}),
  } as any);
  db.putRecord('collection', {
    id: col, version: 1, parent_id: block, parent_table: 'block', space_id: spaceId, alive: true, name: [[name]], template_pages: [],
    schema: {
      title: { name: 'Name', type: 'title' },
      st: { name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Planned', color: 'gray' }, { id: 'o2', value: 'In progress', color: 'blue' }, { id: 'o3', value: 'Done', color: 'green' }] },
      qt: { name: 'Quarter', type: 'select', options: [{ id: 'q1', value: 'Q4', color: 'gray' }, { id: 'q2', value: 'Q1', color: 'gray' }] },
      due: { name: 'Due', type: 'date' },
    },
  } as any);
  db.putRecord('collection_view', { id: view, version: 1, type: 'table', name: 'Table', parent_id: block, parent_table: 'block', space_id: spaceId, alive: true, format: {}, query2: {}, page_sort: [] } as any);
  const p = rec('block', parent);
  db.putRecord('block', { ...p, version: p.version + 1, content: [...(p.content ?? []), block] });
  rows.forEach(([title, st, qt, due], i) => {
    db.putRecord('block', {
      id: newId(), version: 1, type: 'page', parent_id: col, parent_table: 'collection', space_id: spaceId, alive: true,
      properties: { title: [[title]], st: [[st]], qt: [[qt]], due: [['‣', [['d', { type: 'date', start_date: due }]]]] },
      created_time: now + i, created_by_id: A, last_edited_time: now + i, last_edited_by_id: A,
    } as any);
  });
  return { block, col };
}

beforeAll(async () => {
  ({ newId } = await import('@nc/shared/ids.ts'));
  const seed = await import('../src/seed.ts');
  db = await import('../src/db.ts');
  registry = await import('../src/ai/tools/registry.ts');
  litMcp = await import('../src/ai/litMcp.ts');
  shared = await import('@nc/shared/database/index.ts');
  queryctx = await import('../src/queryctx.ts');
  app = (await import('../src/app.ts')).app;
  A = newId();
  B = newId();
  seed.createUser(A, 'a@linked.dev', 'Ann');
  seed.createUser(B, 'b@linked.dev', 'Ben');
  const w = seed.createWorkspace(A, 'Linked');
  spaceId = w.space.id;
  home = w.team.team_pages[0];
  seed.addMember(spaceId, B, 'editor');
  dbs.web = roadmap('Web roadmap', home, [['Login', 'Done', 'Q4', '2026-10-01'], ['Search', 'In progress', 'Q4', '2026-11-15'], ['Dark mode', 'Planned', 'Q1', '2027-02-01']]);
  dbs.app = roadmap('App roadmap', home, [['Push', 'In progress', 'Q4', '2026-12-01'], ['Widgets', 'Planned', 'Q1', '2027-01-10']]);
  // only Ann can open this one
  dbs.secret = roadmap('Secret roadmap', home, [['Acquisition', 'Planned', 'Q4', '2026-12-24']], [{ type: 'user_permission', role: 'editor', user_id: A }]);
  token = litMcp.createToken(A, spaceId, 'test').token;
});

describe('create_linked_views (agent and MCP)', () => {
  it('creates an overview page with one live, filtered view per team roadmap', async () => {
    const r = await tool(env(A), 'create_linked_views', {
      parent: { type: 'page', id: home },
      title: 'Overall roadmap',
      views: [
        { database_id: dbs.web.block, name: 'Web', filters: [{ property: 'Status', operator: 'not_equals', value: 'Done' }], sort: [{ property: 'Due' }] },
        { database_id: dbs.app.block, name: 'App · Q4', type: 'board', group_by: 'Status', filters: [{ property: 'Quarter', operator: 'equals', value: 'Q4' }] },
        { database_id: dbs.web.col, name: 'Timeline', type: 'timeline', date_property: 'Due' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const pageId = /page_id: ([0-9a-f-]{36})/.exec(r.content)![1];
    const page = rec('block', pageId);
    expect(page.properties.title[0][0]).toBe('Overall roadmap');
    const linked = rec('block', page.content[0]);
    expect(linked.type).toBe('collection_view');
    expect(linked.collection_id).toBe(dbs.web.col);
    expect(linked.format.collection_pointers.map((p: any) => p.id)).toEqual([dbs.web.col, dbs.app.col]);
    const vs = viewsOf(linked.id);
    expect(vs.map((v: any) => [v.name, v.type, v.format.collection_pointer.id])).toEqual([['Web', 'table', dbs.web.col], ['App · Q4', 'board', dbs.app.col], ['Timeline', 'timeline', dbs.web.col]]);
    expect(vs[0].query2.filter).toEqual({ operator: 'and', filters: [{ property: 'st', filter: { operator: 'enum_is_not', value: { type: 'exact', value: 'Done' } } }] });
    expect(vs[1].format.board_columns_by.property).toBe('st');
    expect(vs[2].query2.timeline_by).toBe('due');
    // live: the views show the sources' current rows, filtered and sorted
    expect(shown(vs[0].id, A)).toEqual(['Search', 'Dark mode']);
    expect(shown(vs[1].id, A)).toEqual(['Push']);
    // nothing was copied: the sources keep their rows
    expect(db.childrenOf<any>('block', dbs.web.col).filter((b: any) => b.parent_table === 'collection')).toHaveLength(3);
  });

  it('stacked layout: one linked database per view under headings; status groups, dates and people filters', async () => {
    const r = await tool(env(A), 'create_linked_views', {
      parent: { type: 'page', id: home },
      title: 'Due soon',
      layout: 'stacked',
      views: [
        { database_id: dbs.web.block, filters: [{ property: 'Due', operator: 'on_or_after', value: '2026-11-01' }, { property: 'Due', operator: 'before', value: '2027-01-01' }] },
        { database_id: dbs.app.block, filters: [{ property: 'Status', operator: 'equals', value: 'Planned' }, { property: 'Status', operator: 'equals', value: 'In progress' }], filter_match: 'or' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const page = rec('block', /page_id: ([0-9a-f-]{36})/.exec(r.content)![1]);
    const kids = page.content.map((id: string) => rec('block', id));
    expect(kids.map((b: any) => b.type)).toEqual(['sub_header', 'collection_view', 'sub_header', 'collection_view']);
    expect(kids[0].properties.title[0][0]).toBe('Web roadmap');
    expect(shown(kids[1].view_ids[0], A)).toEqual(['Search']);
    expect(shown(kids[3].view_ids[0], A).sort()).toEqual(['Push', 'Widgets']);
  });

  it('adds views as tabs of an existing database, and adds them to the page itself without a title', async () => {
    const target = dbs.web.block;
    const r = await tool(env(A), 'create_linked_views', { target_database_id: target, views: [{ database_id: dbs.app.block, name: 'App' }] });
    expect(r.isError).toBeFalsy();
    const block = rec('block', target);
    expect(block.view_ids).toHaveLength(2);
    expect(block.collection_id).toBe(dbs.web.col);
    expect(block.format.collection_pointers.map((p: any) => p.id)).toEqual([dbs.web.col, dbs.app.col]);
    const before = rec('block', home).content.length;
    const r2 = await tool(env(A), 'create_linked_views', { parent: { type: 'page', id: home }, views: [{ database_id: dbs.app.block }] });
    expect(r2.isError).toBeFalsy();
    expect(rec('block', home).content.length).toBe(before + 1);
  });

  it('refuses sources the person can’t open, unknown properties and options', async () => {
    const r = await tool(env(B), 'create_linked_views', { parent: { type: 'page', id: home }, title: 'Peek', views: [{ database_id: dbs.secret.block }] });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/doesn’t exist|can’t access/);
    const bad = await tool(env(A), 'create_linked_views', { parent: { type: 'page', id: home }, title: 'Bad', views: [{ database_id: dbs.web.block, filters: [{ property: 'Status', operator: 'equals', value: 'Shipped' }] }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('no option “Shipped”');
    const prop = await tool(env(A), 'create_linked_views', { parent: { type: 'page', id: home }, title: 'Bad', views: [{ database_id: dbs.web.block, filters: [{ property: 'Owner', operator: 'contains', value: 'me' }] }] });
    expect(prop.content).toContain('Unknown property “Owner”');
  });

  it('is offered over MCP as lit-create-linked-views', () => {
    const t = litMcp.mcpToolList(spaceId).find((x: any) => x.name === 'lit-create-linked-views') as any;
    expect(t).toBeTruthy();
    expect(t.annotations.readOnlyHint).toBe(false);
    expect(t.inputSchema.required).toEqual(['views']);
  });
});

describe('public API: /v1/views', () => {
  it('builds an overall roadmap on a page: a linked database, then more tabs, live queries', async () => {
    const pg = await api('POST', '/pages', { parent: { page_id: home }, properties: { title: { title: [{ text: { content: 'API roadmap' } }] } } });
    expect(pg.status).toBe(200);
    const first = await api('POST', '/views', {
      parent: { page_id: pg.json.id }, data_source_id: dbs.web.col, type: 'table', name: 'Web open',
      filter: { and: [{ property: 'Status', select: { does_not_equal: 'Done' } }] }, sorts: [{ property: 'Due', direction: 'descending' }],
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ object: 'view', type: 'table', name: 'Web open', data_source_id: dbs.web.col, is_linked: true });
    expect(first.json.filter).toEqual({ and: [{ property: 'Status', select: { does_not_equal: 'Done' } }] });
    expect(first.json.sorts).toEqual([{ property: 'Due', direction: 'descending' }]);
    const dbId = first.json.parent.database_id;
    expect(rec('block', pg.json.id).content).toContain(dbId);

    const second = await api('POST', '/views', { parent: { database_id: dbId }, data_source_id: dbs.app.col, type: 'board', group_by: 'Status', filter: { property: 'Due', date: { on_or_after: '2026-12-01' } } });
    expect(second.status).toBe(200);
    expect(second.json.group_by).toBe('Status');

    const dbo = await api('GET', `/databases/${dbId}`);
    expect(dbo.json.data_sources.map((d: any) => d.id)).toEqual([dbs.web.col, dbs.app.col]);
    const list = await api('GET', `/databases/${dbId}/views`);
    expect(list.json.results.map((v: any) => v.id)).toEqual([first.json.id, second.json.id]);

    const q1 = await api('POST', `/views/${first.json.id}/query`, {});
    expect(q1.json.results.map((p: any) => p.properties.Name.title[0].plain_text)).toEqual(['Dark mode', 'Search']);
    const q2 = await api('POST', `/views/${second.json.id}/query`, {});
    expect(q2.json.results.map((p: any) => p.properties.Name.title[0].plain_text).sort()).toEqual(['Push', 'Widgets']);

    // filters change and clear; the view in the app follows
    const upd = await api('PATCH', `/views/${first.json.id}`, { name: 'Web next quarter', filter: { property: 'Quarter', select: { equals: 'Q1' } }, sorts: null });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ name: 'Web next quarter', sorts: [] });
    expect(shown(first.json.id, A)).toEqual(['Dark mode']);
    const rel = await api('PATCH', `/views/${second.json.id}`, { filter: { property: 'Due', date: { next_year: {} } } });
    expect(rel.json.filter).toEqual({ and: [{ property: 'Due', date: { next_year: {} } }] });

    const del = await api('DELETE', `/views/${second.json.id}`);
    expect(del.status).toBe(200);
    expect(rec('block', dbId).view_ids).toEqual([first.json.id]);
    expect(rec('block', dbId).format.collection_pointers.map((p: any) => p.id)).toEqual([dbs.web.col]);
    expect((await api('DELETE', `/views/${first.json.id}`)).status).toBe(400);
    expect((await api('GET', `/views/${second.json.id}`)).status).toBe(404);
  });

  it('validates filters and sources', async () => {
    const bad = await api('POST', '/views', { parent: { page_id: home }, data_source_id: dbs.web.col, filter: { property: 'Nope', select: { equals: 'x' } } });
    expect(bad.status).toBe(400);
    const ts = await api('POST', '/views', { parent: { page_id: home }, data_source_id: dbs.web.col, filter: { timestamp: 'created_time', created_time: { past_week: {} } } });
    expect(ts.status).toBe(400);
    const missing = await api('POST', '/views', { parent: { page_id: home }, data_source_id: newId() });
    expect(missing.status).toBe(404);
  });
});
