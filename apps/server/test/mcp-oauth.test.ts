// OAuth for the Litpage MCP server (ai/mcpOAuth.ts) against a temporary workspace: metadata discovery, dynamic client
// registration, the consent page (login detour, CSRF, workspace choice), PKCE code exchange, refresh rotation,
// code replay and revocation, the 401 resource metadata hint, and "Approved MCP clients only" at consent.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-mcp-oauth-test-'));
process.env.NC_SCHEDULER = '0';
// OAuth answers with the address the client reached, whatever NC_PUBLIC_URL (links in emails) says
process.env.NC_PUBLIC_URL = 'https://elsewhere.test';

const ORIGIN = 'https://lit.test';
const REDIRECT = 'https://client.example/callback';
let app: typeof import('../src/app.ts').app;
let H: Record<string, (ctx: any, body: any) => any>;
let A = '';
let B = '';
let spaceId = '';
let sessionA = '';
let sessionB = '';

const req = (path: string, init: RequestInit = {}) => app.request(new Request(`${ORIGIN}${path}`, init));
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const mcp = (token: string, method = 'tools/list', params: Record<string, unknown> = {}) =>
  req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

async function register(meta: Record<string, unknown> = {}) {
  const res = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://client.example' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...meta }) });
  return { status: res.status, body: (await res.json()) as any };
}

/** Consent as `session`: returns the redirect Location. */
async function consent(session: string, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` };
  const pageRes = await req(`/oauth/authorize?${form(q)}`, { headers: { cookie: `lit_session=${session}` } });
  const html = await pageRes.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const res = await req('/oauth/authorize', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `lit_session=${session}`, host: 'lit.test', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    body: form({ ...q, csrf, space_id: spaceId, decision: 'allow', ...extra }),
  });
  const out = { html, status: res.status, location: res.headers.get("location") ?? "", body: res.status === 200 ? await res.text() : "" };
  return out;
}

async function token(data: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(data) });
  return { status: res.status, body: (await res.json()) as any };
}

async function connect(session = sessionA) {
  const client = (await register()).body;
  const p = pkce();
  const c = await consent(session, client.client_id, p.challenge);
  const code = new URL(c.location).searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p.verifier, resource: `${ORIGIN}/mcp` });
  return { client, code, verifier: p.verifier, tokens: t.body };
}

beforeAll(async () => {
  ({ app } = await import('../src/app.ts'));
  H = (await import('../src/api/handlers.ts')).handlers as any;
  await import('../src/api/modules/ai.ts');
  const { newId } = await import('@nc/shared/ids.ts');
  const seed = await import('../src/seed.ts');
  const auth = await import('../src/auth.ts');
  A = newId();
  B = newId();
  seed.createUser(A, 'owner@oauth.dev', 'Olive Owner');
  seed.createUser(B, 'member@oauth.dev', 'Max Member');
  spaceId = seed.createWorkspace(A, 'OAuth Lab').space.id;
  seed.addMember(spaceId, B, 'member');
  sessionA = auth.createSession(A);
  sessionB = auth.createSession(B);
});

describe('discovery', () => {
  it('publishes protected resource and authorization server metadata', async () => {
    const pr = (await (await req('/.well-known/oauth-protected-resource/mcp')).json()) as any;
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    expect(((await (await req('/.well-known/oauth-protected-resource/api/mcp')).json()) as any).resource).toBe(`${ORIGIN}/api/mcp`);
    const as = await req('/.well-known/oauth-authorization-server');
    expect(as.headers.get('access-control-allow-origin')).toBe('*');
    expect(await as.json()).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  });

  it('a request without a token points the client at the resource metadata', async () => {
    const res = await req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe('client registration', () => {
  it('registers public and confidential clients and refuses unsafe redirect URIs', async () => {
    const pub = await register();
    expect(pub.status).toBe(201);
    expect(pub.body.client_id).toMatch(/^lp_client_/);
    expect(pub.body.client_secret).toBeUndefined();
    const conf = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    expect(conf.body.client_secret).toMatch(/^lp_cs_/);
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['http://127.0.0.1:3333/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'] })).status).toBe(201);
  });
});

describe('authorization', () => {
  it('signed-out visitors take the login detour; unknown clients and redirect URIs stay on Litpage', async () => {
    const client = (await register()).body;
    const q = form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const detour = await req(`/oauth/authorize?${q}`);
    expect(await detour.text()).toContain("nc:afterLogin");
    const unknown = await req(`/oauth/authorize?${form({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT })}`, { headers: { cookie: `lit_session=${sessionA}` } });
    expect(unknown.status).toBe(400);
    const wrongRedirect = await req(`/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb' })}`, { headers: { cookie: `lit_session=${sessionA}` } });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get('location')).toBeNull();
    // no PKCE: back to the client with an error
    const noPkce = await req(`/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's' })}`, { headers: { cookie: `lit_session=${sessionA}` } });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('the consent page lists the workspace; the form needs the session’s CSRF value and the same origin', async () => {
    const client = (await register()).body;
    const p = pkce();
    const c = await consent(sessionA, client.client_id, p.challenge, { csrf: 'forged' });
    expect(c.html).toContain('OAuth Lab');
    // no-referrer would make browsers send "Origin: null" with the form, which the cross-site check refuses
    expect(c.html).toContain('<meta name="referrer" content="same-origin">');
    expect(c.html).toContain('client.example');
    expect(c.status).toBe(403);
    const crossSite = await req('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `lit_session=${sessionA}`, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: form({ client_id: client.client_id }) });
    expect(crossSite.status).toBe(403);
    const denied = await consent(sessionA, client.client_id, p.challenge, { decision: 'deny' });
    expect(new URL(denied.location).searchParams.get('error')).toBe('access_denied');
    expect(new URL(denied.location).searchParams.get('state')).toBe('xyz');
  });
});

describe('tokens', () => {
  it('exchanges a code with PKCE; the access token works on /mcp and the connection shows in settings', async () => {
    const { client, tokens } = await connect();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tokens.access_token).toMatch(/^lp_oat_/);
    expect(tokens.refresh_token).toMatch(/^lp_ort_/);
    const init = (await (await mcp(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'something else' } })).json()) as any;
    expect(init.result.serverInfo.name).toBe('Litpage MCP');
    const self = (await (await mcp(tokens.access_token, 'tools/call', { name: 'lit-get-self', arguments: {} })).json()) as any;
    expect(JSON.parse(self.result.content[0].text).user.email).toBe('owner@oauth.dev');
    const list = (await H.mcpListTokens({ userId: A, setCookie: () => {} }, { spaceId })).tokens;
    expect(list.find((t: any) => t.oauth && t.name === client.client_name)).toBeTruthy();
    // the grant keeps the registered client, not what initialize reported
    const clients = (await H.mcpListClients({ userId: A, setCookie: () => {} }, { spaceId })).clients;
    expect(clients.some((c: any) => c.key === 'claude')).toBe(true);
    expect(clients.some((c: any) => c.key === 'custom:something-else')).toBe(false);
    // OAuth tokens are for MCP, not the REST API
    expect((await req('/v1/users/me', { headers: { authorization: `Bearer ${tokens.access_token}`, 'lit-version': '2026-10-01' } })).status).toBe(401);
  });

  it('a replayed code fails and revokes what it produced; a wrong verifier fails', async () => {
    const { client, code, verifier, tokens } = await connect();
    const replay = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcp(tokens.access_token)).status).toBe(401);
    const c2 = await consent(sessionA, client.client_id, pkce().challenge);
    const code2 = new URL(c2.location).searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
  });

  it('refresh tokens rotate; revocation ends the grant', async () => {
    const { client, tokens } = await connect();
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }, { origin: 'https://client.example', 'sec-fetch-site': 'cross-site' });
    expect(r1.status).toBe(200);
    expect(r1.body.access_token).not.toBe(tokens.access_token);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect((await mcp(r1.body.access_token)).status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    const rev = await req('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: r1.body.refresh_token, client_id: client.client_id }) });
    expect(rev.status).toBe(200);
    expect((await mcp(r1.body.access_token)).status).toBe(401);
  });

  it('confidential clients authenticate with their secret', async () => {
    const client = (await register({ token_endpoint_auth_method: 'client_secret_basic' })).body;
    const p = pkce();
    const c = await consent(sessionA, client.client_id, p.challenge);
    const code = new URL(c.location).searchParams.get('code')!;
    const bad = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: p.verifier }, { authorization: `Basic ${Buffer.from(`${client.client_id}:wrong`).toString('base64')}` });
    expect(bad.status).toBe(401);
    const c2 = await consent(sessionA, client.client_id, p.challenge);
    const code2 = new URL(c2.location).searchParams.get('code')!;
    const ok = await token({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: p.verifier }, { authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` });
    expect(ok.body.access_token).toMatch(/^lp_oat_/);
  });

  it('authorizing the same client again replaces the earlier grant', async () => {
    const client = (await register()).body;
    const p1 = pkce();
    const c1 = await consent(sessionB, client.client_id, p1.challenge);
    const t1 = await token({ grant_type: 'authorization_code', code: new URL(c1.location).searchParams.get('code')!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p1.verifier });
    const p2 = pkce();
    const c2 = await consent(sessionB, client.client_id, p2.challenge);
    const t2 = await token({ grant_type: 'authorization_code', code: new URL(c2.location).searchParams.get('code')!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p2.verifier });
    expect((await mcp(t1.body.access_token)).status).toBe(401);
    expect((await mcp(t2.body.access_token)).status).toBe(200);
  });
});

describe('workspace policy at consent', () => {
  it('"Approved MCP clients only" keeps members from authorizing an unapproved client; Litpage MCP off blocks the token', async () => {
    const ctxA = { userId: A, setCookie: () => {} };
    await H.mcpSetClientRestriction(ctxA, { spaceId, restricted: true });
    await H.mcpRemoveApprovedClient(ctxA, { spaceId, key: 'claude' });
    const client = (await register({ client_name: 'Shady Tool' })).body;
    const c = await consent(sessionB, client.client_id, pkce().challenge);
    expect(c.html).toContain('None of your workspaces can be connected');
    expect(c.status).toBe(200);
    expect(c.body).toContain('approved');
    await H.mcpSetClientRestriction(ctxA, { spaceId, restricted: false });

    const { tokens } = await connect(sessionB);
    const records = await import('../src/records.ts');
    const { newId } = await import('@nc/shared/ids.ts');
    records.applyTransactions(A, [{ id: newId(), spaceId, operations: [{ pointer: { table: 'space', id: spaceId, spaceId }, path: ['settings'], command: 'update', args: { lit_mcp_enabled: false } }] }], undefined, { client: true });
    expect((await mcp(tokens.access_token)).status).toBe(403);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'x' })).body.error).toBe('invalid_client');
  });
});
