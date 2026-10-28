// One Litpage MCP connection for several workspaces (ai/litMcp.ts, ai/mcpOAuth.ts): workspaces added later in Settings →
// Litpage MCP, the workspace of each call (workspace_id, the page it names, else the home), each workspace's own
// "Allow Litpage MCP", owners of an added workspace removing only theirs, new pages under a team of an added workspace,
// switching the main workspace, and several workspaces ticked at OAuth consent.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-mcp-multi-test-'));
process.env.NC_SCHEDULER = '0';

const ORIGIN = 'https://lit.test';
const REDIRECT = 'https://client.example/callback';
let app: typeof import('../src/app.ts')['app'];
let db: typeof import('../src/db.ts');
let nmcp: typeof import('../src/ai/litMcp.ts');
let H: Record<string, (ctx: any, body: any) => any>;
let newId: () => string;
const ids = {} as Record<string, string>;
const now = Date.now();

const call = async (user: string, name: string, body: any = {}) => H[name]({ userId: user, setCookie: () => {} }, body);
const rpc = (token: string, method: string, params: Record<string, unknown> = {}) => nmcp.handleMcpHttp(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method, params });
const toolCall = async (token: string, name: string, args: Record<string, unknown> = {}) => ((await rpc(token, 'tools/call', { name, arguments: args })).body as any).result as { content: { text: string }[]; isError?: boolean };
function setSettings(spaceId: string, patch: Record<string, unknown>) {
  const s = db.getRecord<any>('space', spaceId);
  db.putRecord('space', { ...s, settings: { ...(s.settings ?? {}), ...patch } });
}
function page(id: string, spaceId: string, title: string) {
  db.putRecord('block' as any, { id, version: 1, alive: true, created_time: now, created_by_id: ids.owner, last_edited_time: now, type: 'page', parent_id: spaceId, parent_table: 'space', space_id: spaceId, properties: { title: [[title]] }, permissions: [{ type: 'space_permission', role: 'editor' }] } as any);
}

beforeAll(async () => {
  ({ newId } = await import('@nc/shared/ids.ts'));
  app = (await import('../src/app.ts')).app;
  H = (await import('../src/api/handlers.ts')).handlers as any;
  db = await import('../src/db.ts');
  nmcp = await import('../src/ai/litMcp.ts');
  await import('../src/api/modules/ai.ts');
  const seed = await import('../src/seed.ts');
  const auth = await import('../src/auth.ts');
  for (const n of ['owner', 'member', 'stranger']) {
    ids[n] = newId();
    seed.createUser(ids[n], `${n}@mcp-multi.test`, n);
  }
  ids.main = seed.createWorkspace(ids.owner, 'Main').space.id;
  ids.second = seed.createWorkspace(ids.owner, 'Second').space.id;
  ids.foreign = seed.createWorkspace(ids.stranger, 'Foreign').space.id;
  seed.addMember(ids.main, ids.member, 'member');
  seed.addMember(ids.second, ids.member, 'member');
  ids.mainPage = newId();
  ids.secondPage = newId();
  page(ids.mainPage, ids.main, 'Main notes amber-otter');
  page(ids.secondPage, ids.second, 'Second notes violet-heron');
  ids.session = auth.createSession(ids.member);
});

describe('a connection reaching more workspaces', () => {
  it('reaches only its home until a workspace is added in Settings, then works there without reconnecting', async () => {
    const { token, info } = await call(ids.member, 'mcpCreateToken', { spaceId: ids.main, name: 'Claude' });
    expect(info.workspaces.map((w: any) => w.id)).toEqual([ids.main]);
    await rpc(token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1' } });
    expect((await toolCall(token, 'lit-fetch', { id: ids.secondPage })).content[0].text).not.toContain('violet-heron');

    // every tool takes the optional workspace_id
    const tools = ((await rpc(token, 'tools/list')).body as any).result.tools as { name: string; inputSchema: any }[];
    expect(tools.find((t) => t.name === 'lit-search')!.inputSchema.properties.workspace_id).toBeTruthy();

    const options = (await call(ids.member, 'mcpTokenWorkspaces', { tokenId: info.id })).workspaces as any[];
    expect(options.map((w) => [w.name, w.home, w.on, w.problem])).toEqual(expect.arrayContaining([['Main', true, true, null], ['Second', false, false, null]]));
    const saved = (await call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.second] })).token;
    expect(saved.workspaces.map((w: any) => w.name)).toEqual(['Main', 'Second']);

    // the page names its workspace; workspace_id picks one by id or name; the home is the default
    expect((await toolCall(token, 'lit-fetch', { id: ids.secondPage })).content[0].text).toContain('violet-heron');
    expect((await toolCall(token, 'lit-fetch', { id: ids.mainPage })).content[0].text).toContain('amber-otter');
    const self = JSON.parse((await toolCall(token, 'lit-get-self')).content[0].text);
    expect(self.workspace.id).toBe(ids.main);
    expect(self.workspaces.map((w: any) => w.name)).toEqual(['Main', 'Second']);
    const unknown = await toolCall(token, 'lit-search', { query: 'notes', workspace_id: 'Nowhere' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('can’t reach');

    // a workspace the person isn't in can't be added
    await expect(call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.second, ids.foreign] })).rejects.toThrow();
    // nor can someone else's connection be changed
    await expect(call(ids.owner, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [] })).rejects.toThrow();

    // each workspace's own switch applies to its calls
    setSettings(ids.second, { lit_mcp_enabled: false });
    const off = await toolCall(token, 'lit-fetch', { id: ids.secondPage });
    expect(off.isError).toBe(true);
    expect(off.content[0].text).toContain('turned off');
    expect((await toolCall(token, 'lit-fetch', { id: ids.mainPage })).content[0].text).toContain('amber-otter');
    setSettings(ids.second, { lit_mcp_enabled: true });

    // the added workspace's owner sees the connection; revoking it there only removes that workspace
    const listed = (await call(ids.owner, 'mcpListTokens', { spaceId: ids.second, all: true })).tokens as any[];
    expect(listed.map((t) => t.id)).toContain(info.id);
    await call(ids.owner, 'mcpRevokeToken', { tokenId: info.id, spaceId: ids.second });
    expect((await toolCall(token, 'lit-fetch', { id: ids.secondPage })).content[0].text).not.toContain('violet-heron');
    expect((await toolCall(token, 'lit-fetch', { id: ids.mainPage })).content[0].text).toContain('amber-otter');

    // "Disconnect everyone" in an added workspace leaves the home connection alone too
    await call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.second] });
    await call(ids.owner, 'mcpRevokeAll', { spaceId: ids.second });
    expect((await call(ids.member, 'mcpListTokens', { spaceId: ids.main })).tokens.find((t: any) => t.id === info.id).workspaces.map((w: any) => w.name)).toEqual(['Main']);
  });
});

describe('creating pages in an added workspace', () => {
  const created = (text: string) => [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => db.getRecord<any>('block', m[0])).find((b) => b?.type === 'page' && b.properties?.title?.[0]?.[0]?.startsWith('Wedding'));

  it('a parent nested in the arguments (a team, or the workspace itself) picks the workspace', async () => {
    const { token, info } = await call(ids.member, 'mcpCreateToken', { spaceId: ids.main, name: 'Claude pages' });
    await call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.second] });
    const team = db.getRecord<any>('space', ids.second).default_team_ids[0];

    const inTeam = await toolCall(token, 'lit-create-pages', { parent: { type: 'teamspace', id: team }, pages: [{ title: 'Wedding guide' }] });
    expect(inTeam.isError).toBeFalsy();
    expect(created(inTeam.content[0].text)?.space_id).toBe(ids.second);

    // the workspace id given as the teamspace: its default team
    const inSpace = await toolCall(token, 'lit-create-pages', { parent: { type: 'teamspace', id: ids.second }, pages: [{ title: 'Wedding extras' }] });
    expect(inSpace.isError).toBeFalsy();
    expect(created(inSpace.content[0].text)?.space_id).toBe(ids.second);
  });

  it('the main workspace can be switched in Settings; pages without a parent go there', async () => {
    const { token, info } = await call(ids.member, 'mcpCreateToken', { spaceId: ids.main, name: 'Claude main' });
    const saved = (await call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.main, ids.second], homeSpaceId: ids.second })).token;
    expect(saved.homeSpaceId).toBe(ids.second);
    expect(saved.workspaces.map((w: any) => w.name)).toEqual(['Second', 'Main']);
    expect(JSON.parse((await toolCall(token, 'lit-get-self')).content[0].text).workspace.id).toBe(ids.second);
    const page = await toolCall(token, 'lit-create-pages', { pages: [{ title: 'Wedding main' }] });
    expect(page.isError).toBeFalsy();
    expect(created(page.content[0].text)?.space_id).toBe(ids.second);
    // the old main workspace is still reached
    expect((await toolCall(token, 'lit-fetch', { id: ids.mainPage })).content[0].text).toContain('amber-otter');
    // a workspace the person isn't in can't become the main one
    await expect(call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [], homeSpaceId: ids.foreign })).rejects.toThrow();
  });
});

describe('every workspace on equal terms', () => {
  it('tells the client the workspaces, creates at a workspace’s top level, searches all of them and names the workspace', async () => {
    const { token, info } = await call(ids.member, 'mcpCreateToken', { spaceId: ids.main, name: 'Claude equal' });
    await call(ids.member, 'mcpSetTokenWorkspaces', { tokenId: info.id, spaceIds: [ids.second] });

    const init = ((await rpc(token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1' } })).body as any).result;
    expect(init.instructions).toContain('Main');
    expect(init.instructions).toContain('Second');
    const tools = ((await rpc(token, 'tools/list')).body as any).result.tools as { name: string; inputSchema: any }[];
    const create = tools.find((t) => t.name === 'lit-create-pages')!.inputSchema;
    expect(create.properties.parent.properties.type.enum).toContain('workspace');
    expect(create.properties.workspace_id.description).toContain(ids.second);
    expect(tools.find((t) => t.name === 'lit-move-pages')!.inputSchema.properties.new_parent.properties.type.enum).toContain('workspace');

    // the top level of a workspace, by name or id
    const byName = await toolCall(token, 'lit-create-pages', { parent: { type: 'workspace', id: 'second' }, pages: [{ title: 'Top level by name' }] });
    expect(byName.isError).toBeFalsy();
    expect(byName.content[0].text).toMatch(/^Workspace: Second/);
    const team = db.getRecord<any>('space', ids.second).default_team_ids[0];
    expect(db.getRecord<any>('team', team).team_pages.map((id: string) => db.getRecord<any>('block', id)?.properties?.title?.[0]?.[0])).toContain('Top level by name');
    const byId = await toolCall(token, 'lit-create-pages', { parent: { type: 'workspace', id: ids.main }, pages: [{ title: 'Top level by id' }] });
    expect(byId.content[0].text).toMatch(/^Workspace: Main/);
    const clash = await toolCall(token, 'lit-create-pages', { workspace_id: ids.main, parent: { type: 'workspace', id: ids.second }, pages: [{ title: 'x' }] });
    expect(clash.isError).toBe(true);

    // no workspace named: every workspace is searched
    const found = (await toolCall(token, 'lit-search', { query: 'Top level' })).content[0].text;
    expect(found).toContain('## Workspace: Main');
    expect(found).toContain('## Workspace: Second');
    expect(found).toContain('Top level by name');
    expect(found).toContain('Top level by id');
    const one = (await toolCall(token, 'lit-search', { query: 'Top level', workspace_id: 'Second' })).content[0].text;
    expect(one).toContain('Top level by name');
    expect(one).not.toContain('Top level by id');
  });
});

describe('OAuth consent', () => {
  const req = (path: string, init: RequestInit = {}) => app.request(new Request(`${ORIGIN}${path}`, init));
  const form = (data: Record<string, string> | [string, string][]) => new URLSearchParams(data).toString();

  it('ticking several workspaces makes one grant that reaches all of them', async () => {
    const reg = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
    const client = (await reg.json()) as any;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256' };
    const html = await (await req(`/oauth/authorize?${form(q)}`, { headers: { cookie: `lit_session=${ids.session}` } })).text();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Second');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const res = await req('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `lit_session=${ids.session}`, host: 'lit.test', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      body: form([...Object.entries(q), ['csrf', csrf], ['decision', 'allow'], ['space_id', ids.second], ['space_id', ids.main]]),
    });
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const tok = (await (await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }) })).json()) as any;
    const self = JSON.parse((await toolCall(tok.access_token, 'lit-get-self')).content[0].text);
    // the first ticked workspace is the home
    expect(self.workspace.id).toBe(ids.second);
    expect(self.workspaces.map((w: any) => w.name)).toEqual(['Second', 'Main']);
    expect((await toolCall(tok.access_token, 'lit-fetch', { id: ids.mainPage })).content[0].text).toContain('amber-otter');
  });
});
