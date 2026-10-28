// OAuth 2.1 authorization server for the Litpage MCP server (MCP authorization, protocol 2025-06-18): MCP clients
// such as Claude, ChatGPT or Cursor connect with only the server URL — the person signs in, picks a workspace and
// allows access, and the client gets a short-lived access token it renews with a refresh token.
//   GET  /.well-known/oauth-protected-resource[/mcp|/api/mcp]  protected resource metadata (RFC 9728)
//   GET  /.well-known/oauth-authorization-server              authorization server metadata (RFC 8414)
//   POST /oauth/register   dynamic client registration (RFC 7591); public clients or client_secret_post/basic
//   GET  /oauth/authorize  consent page (signed-out visitors take the login detour and come back); PKCE S256 only
//   POST /oauth/authorize  the consent form: redirects back with a single-use code (or access_denied); the person can
//                          pick several workspaces — the first is the grant's home, the others are added to it
//   POST /oauth/token      authorization_code (PKCE) and refresh_token grants; refresh tokens rotate on every use
//   POST /oauth/revoke     token revocation (RFC 7009)
// Each grant is a row of mcp_tokens (ai/litMcp.ts) for one person, workspace and client: it shows up in Settings →
// Litpage MCP, revocation and "Disconnect all users" end it, and "Approved MCP clients only" applies to the registered
// client (checked at consent and on every call). Authorizing a client again replaces that person's earlier grant.
// Secrets (client secrets, codes, access and refresh tokens) are stored hashed.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { newId } from '@nc/shared/ids.ts';
import { isSpaceMember } from '@nc/shared/permissions.ts';
import type { SpaceRecord, UserRecord } from '@nc/shared/records.ts';
import { db, getRecord } from '../db.ts';
import { parseCookies, userForToken } from '../auth.ts';
import { esc } from '../mail.ts';
import { hit } from '../ratelimit.ts';
import { DEMO_MESSAGE, isDemoMode } from '../demo.ts';
import { workspaceAiPolicy } from './aiPolicy.ts';
import { activeTokenCount, connectableSpaces, hash, identifyClient, linkSpaces, MAX_TOKENS, spaceProblem } from './litMcp.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  secret_hash TEXT,
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  created_time INTEGER NOT NULL,
  last_used_time INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_time INTEGER NOT NULL,
  used_time INTEGER,
  token_id TEXT
);
`);
// more workspaces chosen at consent (JSON list, besides space_id)
try {
  db.exec('ALTER TABLE oauth_codes ADD COLUMN extra_space_ids TEXT');
} catch {
  /* column exists */
}

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 86400_000;
const SCOPE = 'mcp';
const TRUST_PROXY = process.env.NC_TRUST_PROXY === '1';

// ---------------------------------------------------------------------------------------------
// Addresses

/**
 * The origin the client reached (X-Forwarded-* behind a proxy). Not NC_PUBLIC_URL: MCP clients require the issuer and
 * the endpoints on the host they connected to, and a service can answer on more than one name.
 */
export function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const fwdProto = TRUST_PROXY ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() : undefined;
  const fwdHost = TRUST_PROXY ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : url.protocol.replace(/:$/, '');
  const host = [fwdHost, c.req.header('host'), url.host].find((h) => !!h && /^([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(h)) ?? url.host;
  return `${proto}://${host.toLowerCase()}`;
}

/** Protected resource metadata URL for an MCP endpoint path (/mcp or /api/mcp), announced in 401 responses. */
export function resourceMetadataUrl(c: Context, path: string): string {
  return `${publicOrigin(c)}/.well-known/oauth-protected-resource${path}`;
}

function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

/** RFC 8707 resource indicator: this service's MCP server (any path on its origin), or none. */
function resourceOk(c: Context, resource: string | undefined): boolean {
  if (!resource) return true;
  try {
    const u = new URL(resource);
    return u.origin === publicOrigin(c) && !u.hash;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Clients

interface ClientRow {
  client_id: string;
  secret_hash: string | null;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string;
  auth_method: string;
}

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

function getClient(id: string): ClientRow | undefined {
  if (!id || id.length > 100) return undefined;
  return db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) as ClientRow | undefined;
}

const redirectUris = (c: ClientRow): string[] => {
  try {
    return JSON.parse(c.redirect_uris) as string[];
  } catch {
    return [];
  }
};

/** https, http on loopback only (RFC 8252 native apps), or a private-use scheme such as cursor://; no fragments. */
export function redirectUriOk(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:', 'ws:', 'wss:', 'ftp:'].includes(u.protocol);
}

/** Registered redirect URIs match exactly, except that loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(client: ClientRow, uri: string): boolean {
  for (const r of redirectUris(client)) {
    if (r === uri) return true;
    try {
      const a = new URL(r);
      const b = new URL(uri);
      if (a.protocol === 'http:' && b.protocol === 'http:' && a.hostname === b.hostname && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(a.hostname) && a.pathname === b.pathname && a.search === b.search) return true;
    } catch {
      /* not a URL */
    }
  }
  return false;
}

export class OAuthError extends Error {
  error: string;
  status: number;
  constructor(error: string, message: string, status = 400) {
    super(message);
    this.error = error;
    this.status = status;
  }
}

/** Dynamic client registration (RFC 7591). */
export function registerClient(meta: Record<string, unknown>): Record<string, unknown> {
  const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
  if (!uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'Register between 1 and 10 redirect URIs.');
  const bad = uris.find((u) => !redirectUriOk(u));
  if (bad !== undefined) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${String(bad).slice(0, 200)}`);
  const method = typeof meta.token_endpoint_auth_method === 'string' ? meta.token_endpoint_auth_method : 'client_secret_basic';
  if (!AUTH_METHODS.includes(method)) throw new OAuthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${method.slice(0, 60)}`);
  const grants = Array.isArray(meta.grant_types) ? meta.grant_types.map(String) : ['authorization_code'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) throw new OAuthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.');
  const responses = Array.isArray(meta.response_types) ? meta.response_types.map(String) : ['code'];
  if (responses.some((r) => r !== 'code')) throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
  const name = (typeof meta.client_name === 'string' ? meta.client_name : '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'MCP client';
  const clientUri = typeof meta.client_uri === 'string' && /^https:\/\//i.test(meta.client_uri) && meta.client_uri.length <= 500 ? meta.client_uri : null;
  const clientId = `lp_client_${randomBytes(16).toString('base64url')}`;
  const secret = method === 'none' ? null : `lp_cs_${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  db.prepare('INSERT INTO oauth_clients (client_id, secret_hash, client_name, client_uri, redirect_uris, auth_method, created_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(clientId, secret ? hash(secret) : null, name, clientUri, JSON.stringify(uris), method, now);
  return {
    client_id: clientId, client_id_issued_at: Math.floor(now / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name, ...(clientUri ? { client_uri: clientUri } : {}), redirect_uris: uris, token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
  };
}

/** Client authentication at the token and revocation endpoints (none, client_secret_post, client_secret_basic). */
function authenticateClient(c: Context, form: Record<string, string>): ClientRow {
  let id = form.client_id ?? '';
  let secret = form.client_secret;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(c.req.header('authorization') ?? '');
  if (basic) {
    const raw = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 0) throw new OAuthError('invalid_client', 'Malformed client credentials.', 401);
    try {
      id = decodeURIComponent(raw.slice(0, i));
      secret = decodeURIComponent(raw.slice(i + 1));
    } catch {
      throw new OAuthError('invalid_client', 'Malformed client credentials.', 401);
    }
  }
  const client = getClient(id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
  if (client.secret_hash) {
    const given = Buffer.from(hash(secret ?? ''), 'hex');
    if (!secret || !timingSafeEqual(given, Buffer.from(client.secret_hash, 'hex'))) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
  }
  return client;
}

// ---------------------------------------------------------------------------------------------
// Authorization

export interface AuthorizeRequest {
  client: ClientRow;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource?: string;
}

/**
 * Validate the authorization request. Problems with the client or its redirect URI are shown on our own page
 * (`fatal`); everything else goes back to the client as an OAuth error redirect.
 */
function parseAuthorize(c: Context, q: Record<string, string>): { ok: AuthorizeRequest } | { fatal: string } | { redirect: string } {
  const client = getClient(q.client_id ?? '');
  if (!client) return { fatal: 'This app isn’t registered with Litpage. Try connecting it again.' };
  const redirectUri = q.redirect_uri ?? (redirectUris(client).length === 1 ? redirectUris(client)[0] : '');
  if (!redirectUri || !redirectMatches(client, redirectUri)) return { fatal: 'This app asked to return to an address it didn’t register.' };
  const state = (q.state ?? '').slice(0, 1000);
  const back = (error: string, description: string) => ({ redirect: withParams(redirectUri, { error, error_description: description, ...(state ? { state } : {}), iss: publicOrigin(c) }) });
  if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
  if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'PKCE is required: send a code_challenge.');
  if ((q.code_challenge_method ?? 'plain') !== 'S256') return back('invalid_request', 'Only the S256 code_challenge_method is supported.');
  if (!resourceOk(c, q.resource)) return back('invalid_target', 'Unknown resource.');
  return { ok: { client, redirectUri, state, codeChallenge: q.code_challenge, resource: q.resource || undefined } };
}

function withParams(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Ties the consent form to the signed-in session (on top of the same-origin check for POSTs). */
const csrfFor = (session: string) => hash(`oauth-consent:${session}`).slice(0, 32);

/** The consent decision: a single-use code for the chosen workspaces (the first is the grant's home). */
export function issueCode(req: AuthorizeRequest, userId: string, spaceIds: string | string[]): string {
  const ids = [...new Set((Array.isArray(spaceIds) ? spaceIds : [spaceIds]).map(String).filter(Boolean))].slice(0, 50);
  const spaceId = ids[0];
  if (!spaceId) throw new OAuthError('access_denied', 'Choose a workspace to connect.', 400);
  const key = identifyClient(req.client.client_name).key;
  for (const id of ids) {
    const problem = spaceProblem(id, userId, key);
    if (problem) throw new OAuthError('access_denied', ids.length > 1 ? `${getRecord<SpaceRecord>('space', id)?.name || 'Workspace'}: ${problem}` : problem, 403);
  }
  const replaced = (db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND space_id = ? AND oauth_client_id = ? AND revoked_time IS NULL').get(userId, spaceId, req.client.client_id) as { n: number }).n;
  if (activeTokenCount(userId, spaceId) - replaced >= MAX_TOKENS) throw new OAuthError('access_denied', `You can have up to ${MAX_TOKENS} active MCP connections in this workspace. Revoke one in Settings → Litpage MCP.`, 400);
  const code = `lp_oac_${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  db.prepare('DELETE FROM oauth_codes WHERE expires_time < ?').run(now - 86400_000);
  db.prepare('INSERT INTO oauth_codes (code_hash, client_id, user_id, space_id, redirect_uri, code_challenge, resource, expires_time, extra_space_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(hash(code), req.client.client_id, userId, spaceId, req.redirectUri, req.codeChallenge, req.resource ?? null, now + CODE_TTL_MS, ids.length > 1 ? JSON.stringify(ids.slice(1)) : null);
  return code;
}

// ---------------------------------------------------------------------------------------------
// Tokens

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function newTokens(): { access: string; refresh: string; response: (access: string, refresh: string) => TokenResponse } {
  return {
    access: `lp_oat_${randomBytes(32).toString('base64url')}`,
    refresh: `lp_ort_${randomBytes(32).toString('base64url')}`,
    response: (access, refresh) => ({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }),
  };
}

const s256 = (verifier: string) => Buffer.from(hash(verifier), 'hex').toString('base64url');

/** authorization_code grant: verify the code, PKCE and redirect URI, then create the grant. */
export function exchangeCode(c: Context, client: ClientRow, form: Record<string, string>): TokenResponse {
  const code = form.code ?? '';
  const row = /^lp_oac_[A-Za-z0-9_-]{20,}$/.test(code)
    ? db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(code)) as { client_id: string; user_id: string; space_id: string; redirect_uri: string; code_challenge: string; resource: string | null; expires_time: number; used_time: number | null; token_id: string | null; extra_space_ids: string | null } | undefined
    : undefined;
  if (!row || row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'The authorization code is invalid.');
  if (row.used_time) {
    // a replayed code: whatever it produced is no longer trustworthy (RFC 6749 §4.1.2)
    if (row.token_id) db.prepare('UPDATE mcp_tokens SET revoked_time = ? WHERE id = ? AND revoked_time IS NULL').run(Date.now(), row.token_id);
    throw new OAuthError('invalid_grant', 'The authorization code was already used.');
  }
  // claim the code before anything else, so concurrent exchanges can't both succeed
  if (!db.prepare('UPDATE oauth_codes SET used_time = ? WHERE code_hash = ? AND used_time IS NULL').run(Date.now(), hash(code)).changes) throw new OAuthError('invalid_grant', 'The authorization code was already used.');
  if (row.expires_time < Date.now()) throw new OAuthError('invalid_grant', 'The authorization code has expired.');
  if ((form.redirect_uri ?? row.redirect_uri) !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri doesn’t match the authorization request.');
  const verifier = form.code_verifier ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== row.code_challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
  if (form.resource && (!resourceOk(c, form.resource) || (row.resource && form.resource !== row.resource))) throw new OAuthError('invalid_target', 'The resource doesn’t match the authorization request.');
  if (!isSpaceMember(getRecord<SpaceRecord>('space', row.space_id), row.user_id) || !workspaceAiPolicy(row.space_id).litMcp) throw new OAuthError('invalid_grant', 'This workspace can’t be connected anymore.');

  const t = newTokens();
  const now = Date.now();
  const id = newId();
  const cl = identifyClient(client.client_name);
  db.prepare('UPDATE mcp_tokens SET revoked_time = ? WHERE user_id = ? AND space_id = ? AND oauth_client_id = ? AND revoked_time IS NULL').run(now, row.user_id, row.space_id, client.client_id);
  db.prepare(`INSERT INTO mcp_tokens (id, user_id, space_id, name, token_hash, prefix, created_time, client_key, client_name, oauth_client_id, expires_time, refresh_hash, refresh_expires_time)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, row.user_id, row.space_id, client.client_name.slice(0, 60), hash(t.access), t.access.slice(0, 12), now, cl.key, cl.name, client.client_id, now + ACCESS_TTL_S * 1000, hash(t.refresh), now + REFRESH_TTL_MS);
  db.prepare('UPDATE oauth_codes SET token_id = ? WHERE code_hash = ?').run(id, hash(code));
  let extra: string[] = [];
  try {
    extra = row.extra_space_ids ? (JSON.parse(row.extra_space_ids) as string[]) : [];
  } catch {
    /* none */
  }
  // the other workspaces chosen at consent, those that can still be connected
  linkSpaces(id, extra.filter((s) => typeof s === 'string' && !spaceProblem(s, row.user_id, cl.key)));
  db.prepare('UPDATE oauth_clients SET last_used_time = ? WHERE client_id = ?').run(now, client.client_id);
  return t.response(t.access, t.refresh);
}

/** refresh_token grant: rotate both tokens of the grant. */
export function refreshGrant(client: ClientRow, form: Record<string, string>): TokenResponse {
  const refresh = form.refresh_token ?? '';
  const row = /^lp_ort_[A-Za-z0-9_-]{20,}$/.test(refresh)
    ? db.prepare('SELECT id, user_id, space_id, oauth_client_id, refresh_expires_time FROM mcp_tokens WHERE refresh_hash = ? AND revoked_time IS NULL').get(hash(refresh)) as { id: string; user_id: string; space_id: string; oauth_client_id: string; refresh_expires_time: number } | undefined
    : undefined;
  if (!row || row.oauth_client_id !== client.client_id || row.refresh_expires_time < Date.now()) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
  if (!isSpaceMember(getRecord<SpaceRecord>('space', row.space_id), row.user_id) || !workspaceAiPolicy(row.space_id).litMcp) throw new OAuthError('invalid_grant', 'This workspace can’t be connected anymore.');
  const t = newTokens();
  const now = Date.now();
  const r = db.prepare('UPDATE mcp_tokens SET token_hash = ?, prefix = ?, expires_time = ?, refresh_hash = ?, refresh_expires_time = ? WHERE id = ? AND refresh_hash = ? AND revoked_time IS NULL')
    .run(hash(t.access), t.access.slice(0, 12), now + ACCESS_TTL_S * 1000, hash(t.refresh), now + REFRESH_TTL_MS, row.id, hash(refresh));
  if (!r.changes) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
  db.prepare('UPDATE oauth_clients SET last_used_time = ? WHERE client_id = ?').run(now, client.client_id);
  return t.response(t.access, t.refresh);
}

/** RFC 7009: revoke the grant behind an access or refresh token of this client (unknown tokens are fine). */
export function revokeGrant(client: ClientRow, token: string) {
  if (!/^lp_o[ar]t_[A-Za-z0-9_-]{20,}$/.test(token)) return;
  const h = hash(token);
  db.prepare('UPDATE mcp_tokens SET revoked_time = ? WHERE (token_hash = ? OR refresh_hash = ?) AND oauth_client_id = ? AND revoked_time IS NULL').run(Date.now(), h, h, client.client_id);
}

// ---------------------------------------------------------------------------------------------
// Pages

function page(title: string, body: string, nonce?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="same-origin">
<title>${esc(title)}</title><style${nonce ? ` nonce="${nonce}"` : ''}>
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#37352f;--muted:#787774;--line:#e9e9e7;--accent:#2383e2}
@media (prefers-color-scheme:dark){:root{--bg:#191919;--card:#252525;--text:#e6e6e4;--muted:#9b9a97;--line:#373737}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px}ul{margin:0 0 16px;padding-left:20px}
fieldset{border:0;margin:0 0 16px;padding:0}legend{font-weight:600;margin-bottom:6px}
label.ws{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;cursor:pointer}
.actions{display:flex;gap:8px;justify-content:flex-end}button{font:inherit;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}code{word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // no form-action: the consent form's response redirects to the client's own address
      'Content-Security-Policy': `default-src 'none'; style-src ${nonce ? `'nonce-${nonce}'` : "'unsafe-inline'"}; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; base-uri 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
    },
  });
}

const errorPage = (message: string, status = 400) => {
  const r = page('Can’t connect', `<h1>Can’t connect this app</h1><p>${esc(message)}</p>`);
  return new Response(r.body, { status, headers: r.headers });
};

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return uri;
  }
}

function consentPage(req: AuthorizeRequest, userId: string, session: string, problem?: string): Response {
  const user = getRecord<UserRecord>('lit_user', userId);
  const spaces = connectableSpaces(userId, identifyClient(req.client.client_name).key);
  const name = esc(req.client.client_name);
  const hidden = (k: string, v: string | undefined) => (v ? `<input type="hidden" name="${k}" value="${esc(v)}">` : '');
  const list = spaces.map((s, i) => `<label class="ws"><input type="checkbox" name="space_id" value="${esc(s.id)}"${i === 0 ? ' checked' : ''}> ${esc(s.icon && s.icon.length <= 4 ? `${s.icon} ` : '')}${esc(s.name)}</label>`).join('');
  const nonce = randomBytes(16).toString('base64');
  return page(`Connect ${req.client.client_name} to Litpage`, `
<h1>${name} wants to access your Litpage workspace</h1>
${problem ? `<p role="alert"><strong>${esc(problem)}</strong></p>` : ''}
<p>It will act as <strong>${esc(user?.name || user?.email || 'you')}</strong>${user?.email && user?.name ? ` (${esc(user.email)})` : ''} with your permissions:</p>
<ul><li>search and read pages, databases and comments</li><li>create and edit pages and databases, and add comments</li></ul>
<form method="post" action="/oauth/authorize">
${hidden('client_id', req.client.client_id)}${hidden('redirect_uri', req.redirectUri)}${hidden('state', req.state)}${hidden('code_challenge', req.codeChallenge)}${hidden('resource', req.resource)}
<input type="hidden" name="response_type" value="code"><input type="hidden" name="code_challenge_method" value="S256"><input type="hidden" name="csrf" value="${csrfFor(session)}">
${spaces.length ? `<fieldset><legend>${spaces.length > 1 ? 'Workspaces' : 'Workspace'}</legend>${list}${spaces.length > 1 ? '<p class="muted">The first one you tick is the main workspace. You can add or remove workspaces later in Settings → Litpage MCP.</p>' : ''}</fieldset>` : `<p><strong>None of your workspaces can be connected.</strong> Litpage MCP is turned off, or a workspace owner hasn’t approved ${name}.</p>`}
<p class="muted">You’ll be sent back to <code>${esc(hostOf(req.redirectUri))}</code>. You can disconnect it anytime in Settings → Litpage MCP.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Cancel</button>${spaces.length ? '<button type="submit" name="decision" value="allow" class="primary">Allow access</button>' : ''}</div>
</form>`, nonce);
}

/** Signed out: remember where to come back to and take the login page (the web app returns here afterwards). */
function loginDetour(c: Context): Response {
  const url = new URL(c.req.url);
  const back = `/oauth/authorize${url.search}`;
  const nonce = randomBytes(16).toString('base64');
  return page('Sign in to Litpage', `<h1>Sign in to continue</h1><p>Sign in to Litpage to connect this app.</p><p><a href="/login">Continue to sign in</a></p>
<script nonce="${nonce}">try{sessionStorage.setItem('nc:afterLogin',${JSON.stringify(back).replace(/</g, '\\u003c')})}catch(e){}location.replace('/login')</script>`, nonce);
}

// ---------------------------------------------------------------------------------------------
// Routes

async function formOf(c: Context): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const type = c.req.header('content-type') ?? '';
  if (/^application\/json\b/i.test(type)) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  }
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) return out;
  const text = await c.req.text();
  if (text.length > 64 * 1024) return out;
  // repeated space_id (several workspaces ticked) comes back comma-separated
  for (const [k, v] of new URLSearchParams(text)) out[k] = k === 'space_id' && out[k] ? `${out[k]},${v}` : v;
  return out;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Max-Age': '86400' };
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthJson(c: Context, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return c.json(body as object, status as 200, { ...CORS, ...NO_STORE, ...extra });
}

function oauthFail(c: Context, e: unknown) {
  if (e instanceof OAuthError) {
    return oauthJson(c, { error: e.error, error_description: e.message }, e.status, e.status === 401 ? { 'WWW-Authenticate': 'Basic realm="Litpage OAuth"' } : {});
  }
  console.error('[oauth] failed', e);
  return oauthJson(c, { error: 'server_error', error_description: 'Something went wrong.' }, 500);
}

/** Paths the OAuth endpoints serve to other origins (no cookies involved): CORS and no CSRF origin check. */
export const OAUTH_CROSS_ORIGIN = /^\/(\.well-known\/oauth-(protected-resource|authorization-server)(\/.*)?|oauth\/(token|register|revoke))$/;

export function registerMcpOAuth(app: Hono) {
  const demoOff = (c: Context) => (isDemoMode() ? oauthJson(c, { error: 'access_denied', error_description: DEMO_MESSAGE }, 403) : null);

  app.options('/.well-known/*', (c) => c.body(null, 204, CORS));
  app.options('/oauth/*', (c) => c.body(null, 204, CORS));

  const resourceMeta = (c: Context, path: string) => {
    const origin = publicOrigin(c);
    return c.json({
      resource: `${origin}${path}`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Litpage MCP',
    }, 200, { ...CORS, 'Cache-Control': 'public, max-age=3600' });
  };
  // the root document names the whole origin, so it covers clients connected to either endpoint path
  app.get('/.well-known/oauth-protected-resource', (c) => resourceMeta(c, ''));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => resourceMeta(c, '/mcp'));
  app.get('/.well-known/oauth-protected-resource/api/mcp', (c) => resourceMeta(c, '/api/mcp'));

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const o = publicOrigin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    }, 200, { ...CORS, 'Cache-Control': 'public, max-age=3600' });
  });

  app.post('/oauth/register', async (c) => {
    const off = demoOff(c);
    if (off) return off;
    if (!hit(`oauth:register:${clientIp(c)}`, Number(process.env.NC_OAUTH_REGISTER_PER_HOUR) || 30, 3600_000)) return oauthJson(c, { error: 'temporarily_unavailable', error_description: 'Too many registrations. Try again later.' }, 429);
    if (Number(c.req.header('content-length') ?? 0) > 64 * 1024) return oauthJson(c, { error: 'invalid_client_metadata', error_description: 'Request is too large.' }, 413);
    const meta = await c.req.json().catch(() => null);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return oauthJson(c, { error: 'invalid_client_metadata', error_description: 'Send the client metadata as a JSON object.' }, 400);
    try {
      return oauthJson(c, registerClient(meta as Record<string, unknown>), 201);
    } catch (e) {
      return oauthFail(c, e);
    }
  });

  app.get('/oauth/authorize', (c) => {
    if (isDemoMode()) return errorPage(DEMO_MESSAGE, 403);
    const parsed = parseAuthorize(c, c.req.query());
    if ('fatal' in parsed) return errorPage(parsed.fatal);
    if ('redirect' in parsed) return c.redirect(parsed.redirect, 302);
    const session = parseCookies(c.req.header('cookie')).lit_session;
    const userId = userForToken(session);
    if (!userId || !session) return loginDetour(c);
    return consentPage(parsed.ok, userId, session);
  });

  app.post('/oauth/authorize', async (c) => {
    if (isDemoMode()) return errorPage(DEMO_MESSAGE, 403);
    const form = await formOf(c);
    const session = parseCookies(c.req.header('cookie')).lit_session;
    const userId = userForToken(session);
    if (!userId || !session) return errorPage('Your session ended. Start connecting the app again.', 401);
    const given = Buffer.from(form.csrf ?? '');
    const want = Buffer.from(csrfFor(session));
    if (given.length !== want.length || !timingSafeEqual(given, want)) return errorPage('This form expired. Start connecting the app again.', 403);
    const parsed = parseAuthorize(c, form);
    if ('fatal' in parsed) return errorPage(parsed.fatal);
    if ('redirect' in parsed) return c.redirect(parsed.redirect, 302);
    const req = parsed.ok;
    const back = (params: Record<string, string>) => c.redirect(withParams(req.redirectUri, { ...params, ...(req.state ? { state: req.state } : {}), iss: publicOrigin(c) }), 302);
    if (form.decision !== 'allow') return back({ error: 'access_denied', error_description: 'The person declined access.' });
    if (!hit(`oauth:consent:${userId}`, 30, 60_000)) return errorPage('Too many attempts. Try again shortly.', 429);
    try {
      return back({ code: issueCode(req, userId, String(form.space_id ?? '').split(',')) });
    } catch (e) {
      if (e instanceof OAuthError) return consentPage(req, userId, session, e.message);
      throw e;
    }
  });

  app.post('/oauth/token', async (c) => {
    const off = demoOff(c);
    if (off) return off;
    if (!hit(`oauth:token:${clientIp(c)}`, Number(process.env.NC_OAUTH_TOKEN_PER_MIN) || 60, 60_000)) return oauthJson(c, { error: 'temporarily_unavailable', error_description: 'Too many requests. Try again shortly.' }, 429);
    const form = await formOf(c);
    try {
      const client = authenticateClient(c, form);
      if (form.grant_type === 'authorization_code') return oauthJson(c, exchangeCode(c, client, form));
      if (form.grant_type === 'refresh_token') return oauthJson(c, refreshGrant(client, form));
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    } catch (e) {
      return oauthFail(c, e);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const off = demoOff(c);
    if (off) return off;
    const form = await formOf(c);
    try {
      revokeGrant(authenticateClient(c, form), form.token ?? '');
      return c.body(null, 200, { ...CORS, ...NO_STORE });
    } catch (e) {
      return oauthFail(c, e);
    }
  });
}
