// MCP server (Settings → MCP): this workspace as a Model Context Protocol server for external AI tools.
// Streamable HTTP transport, JSON responses: POST /api/mcp with JSON-RPC 2.0 — initialize, notifications/*, ping,
// tools/list, tools/call. Clients authenticate with a personal access token created in Settings → MCP
// ("Authorization: Bearer lp_pat_…"); every tool runs as the token's user through the agent tool registry, so the
// same permission checks, change log and realtime updates apply as in AI chat. Tokens are stored hashed;
// workspace owners can see and revoke all of them ("Disconnect all users").
// MCP clients: each token remembers the client that connected with it (initialize's
// clientInfo, the catalog name or the self-reported name of an unknown client). Owners can restrict members to
// "Approved MCP clients only" (calls from other clients are blocked; clients owners connect are approved
// automatically), rename a client for the workspace, see who connected each client and when it was last used, and
// disconnect one member or everyone from a client. Memory sync : lit-get-memories / lit-save-memory
// read and append the person's AI memories (their AI instructions page) when Memories are on.
// OAuth (ai/mcpOAuth.ts): clients that support MCP authorization sign the person in instead of pasting a token; each
// grant is a row here too ("lp_oat_…" access tokens that expire, rotated with a refresh token), so listing,
// revocation and the client policy treat both kinds alike. The client of an OAuth row is its registration.
// More workspaces: a connection belongs to the workspace it was made in (its home, mcp_tokens.space_id) and can reach
// more of its person's workspaces (mcp_token_spaces) — chosen at OAuth consent or added later in Settings → Litpage
// MCP, so one MCP client connector (one server URL) works across workspaces. Each call works in one workspace: the
// tools' optional workspace_id, else the workspace of the page or database it names, else the home; that
// workspace's "Allow Litpage MCP" and approved clients apply to the call. Owners of a workspace the connection was
// added to see it in their lists; revoking it there removes only that workspace from the connection.
import { createHash, randomBytes } from 'node:crypto';
import { expandId, newId } from '@nc/shared/ids.ts';
import { isSpaceMember } from '@nc/shared/permissions.ts';
import { isSpaceOwner } from '../policy.ts';
import type { BlockRecord, SpaceRecord, SpaceViewRecord, TeamRecord, UserRecord, UserRootRecord, UserSettingsRecord } from '@nc/shared/records.ts';
import { db, getRecord } from '../db.ts';
import { audit } from '../audit.ts';
import { realtime } from '../realtime.ts';
import { saveRecord } from '../seed.ts';
import { hit } from '../ratelimit.ts';
import { workspaceAiPolicy } from './aiPolicy.ts';
import { AiError } from './client.ts';
import { mdSource } from './context.ts';
import { pageToMarkdown } from './prompts.ts';
import { blockRole } from '../records.ts';
import { listSkills, skillById } from './skills.ts';
import { TOOL_DEFS } from './tools/defs.ts';
import { runTool } from './tools/registry.ts';
import type { AgentEnv } from './tools/types.ts';
import { DEMO_MESSAGE, isDemoMode } from '../demo.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_time INTEGER NOT NULL,
  last_used_time INTEGER,
  revoked_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_space ON mcp_tokens(space_id, user_id);
`);
// MCP client of each token (added with the approved MCP clients list)
// OAuth grants (ai/mcpOAuth.ts): registered client, access token expiry, refresh token
for (const col of ['client_key TEXT', 'client_name TEXT', 'first_connected_time INTEGER', 'oauth_client_id TEXT', 'expires_time INTEGER', 'refresh_hash TEXT', 'refresh_expires_time INTEGER']) {
  try {
    db.exec(`ALTER TABLE mcp_tokens ADD COLUMN ${col}`);
  } catch {
    /* column exists */
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_tokens_refresh ON mcp_tokens(refresh_hash)');
db.exec(`
CREATE TABLE IF NOT EXISTS mcp_token_spaces (
  token_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  added_time INTEGER NOT NULL,
  PRIMARY KEY (token_id, space_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_token_spaces_space ON mcp_token_spaces(space_id);
`);

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const hash = (t: string) => createHash('sha256').update(t).digest('hex');
/** Active tokens a person can have per workspace (access tokens and OAuth grants together). */
export const MAX_TOKENS = 20;

export interface McpTokenInfo {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  userName?: string;
  createdTime: number;
  lastUsedTime: number | null;
  /** connected through OAuth (no token to copy; the client signs in again after revocation) */
  oauth: boolean;
  /** the workspace the connection was made in */
  homeSpaceId: string;
  /** every workspace the connection reaches, home first */
  workspaces: { id: string; name: string }[];
}

interface TokenRow {
  id: string;
  user_id: string;
  space_id: string;
  name: string;
  prefix: string;
  created_time: number;
  last_used_time: number | null;
  oauth_client_id?: string | null;
  expires_time?: number | null;
}

const info = (r: TokenRow): McpTokenInfo => ({
  id: r.id, name: r.name, prefix: r.prefix, userId: r.user_id, userName: getRecord<UserRecord>('lit_user', r.user_id)?.name, createdTime: r.created_time, lastUsedTime: r.last_used_time,
  oauth: !!r.oauth_client_id, homeSpaceId: r.space_id,
  workspaces: tokenSpaces(r.id, r.space_id, r.user_id).map((id) => ({ id, name: getRecord<SpaceRecord>('space', id)?.name || 'Untitled workspace' })),
});

/** Tokens that reach a workspace: made there, or added to it (SQL condition on mcp_tokens, one parameter). */
const REACHES = '(space_id = ? OR id IN (SELECT token_id FROM mcp_token_spaces WHERE space_id = ?))';

/** The workspaces a connection reaches (home first) that its person is still a member of. */
export function tokenSpaces(tokenId: string, homeSpaceId: string, userId: string): string[] {
  const linked = (db.prepare('SELECT space_id FROM mcp_token_spaces WHERE token_id = ? ORDER BY added_time').all(tokenId) as { space_id: string }[]).map((r) => r.space_id);
  return [homeSpaceId, ...linked.filter((id) => id !== homeSpaceId)].filter((id) => isSpaceMember(getRecord<SpaceRecord>('space', id), userId));
}

/**
 * Take a workspace away from the active connections matching `where` (SQL on mcp_tokens, with `params`): connections
 * made there are revoked, connections added to it only lose that workspace. Returns how many connections changed.
 */
function cutOff(spaceId: string, where: string, params: (string | number)[]): number {
  const now = Date.now();
  const revoked = Number(db.prepare(`UPDATE mcp_tokens SET revoked_time = ? WHERE space_id = ? AND revoked_time IS NULL AND ${where}`).run(now, spaceId, ...params).changes ?? 0);
  const unlinked = Number(db.prepare(`DELETE FROM mcp_token_spaces WHERE space_id = ? AND token_id IN (SELECT id FROM mcp_tokens WHERE revoked_time IS NULL AND ${where})`).run(spaceId, ...params).changes ?? 0);
  return revoked + unlinked;
}

export function activeTokenCount(userId: string, spaceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND space_id = ? AND revoked_time IS NULL').get(userId, spaceId) as { n: number }).n;
}

export function createToken(userId: string, spaceId: string, name: string): { token: string; info: McpTokenInfo } {
  if (!isSpaceMember(getRecord<SpaceRecord>('space', spaceId), userId)) throw new AiError('forbidden', 'You aren’t a member of this workspace.', 403);
  if (!workspaceAiPolicy(spaceId).litMcp) throw new AiError('forbidden', 'Litpage MCP is turned off for this workspace.', 403);
  if (activeTokenCount(userId, spaceId) >= MAX_TOKENS) throw new AiError('bad_request', `You can have up to ${MAX_TOKENS} active tokens.`, 400);
  const token = `lp_pat_${randomBytes(24).toString('base64url')}`;
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO mcp_tokens (id, user_id, space_id, name, token_hash, prefix, created_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, spaceId, (name || 'MCP client').trim().slice(0, 60), hash(token), token.slice(0, 12), now);
  return { token, info: info(db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(id) as unknown as TokenRow) };
}

/** The user's own tokens, or (workspace owners with all = true) every active token in the workspace. */
export function listTokens(userId: string, spaceId: string, all = false): McpTokenInfo[] {
  const space = getRecord<SpaceRecord>('space', spaceId);
  if (!isSpaceMember(space, userId)) throw new AiError('forbidden', 'You aren’t a member of this workspace.', 403);
  if (all && !isSpaceOwner(space, userId)) throw new AiError('forbidden', 'Only workspace owners can see every connection.', 403);
  const rows = all
    ? db.prepare(`SELECT * FROM mcp_tokens WHERE ${REACHES} AND revoked_time IS NULL ORDER BY created_time DESC`).all(spaceId, spaceId)
    : db.prepare(`SELECT * FROM mcp_tokens WHERE ${REACHES} AND user_id = ? AND revoked_time IS NULL ORDER BY created_time DESC`).all(spaceId, spaceId, userId);
  return (rows as unknown as TokenRow[]).map(info);
}

/**
 * Revoke a connection — its person or an owner of its home workspace. With `spaceId` (the workspace whose list it
 * was revoked from) a connection made in another workspace only loses `spaceId` (its person or an owner there).
 */
export function revokeToken(userId: string, tokenId: string, spaceId?: string) {
  const r = db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(String(tokenId)) as (TokenRow & { space_id: string }) | undefined;
  if (!r) throw new AiError('not_found', 'That token doesn’t exist.', 404);
  if (spaceId && spaceId !== r.space_id && db.prepare('SELECT 1 FROM mcp_token_spaces WHERE token_id = ? AND space_id = ?').get(r.id, spaceId)) {
    if (r.user_id !== userId && !isSpaceOwner(getRecord<SpaceRecord>('space', spaceId), userId)) throw new AiError('forbidden', 'You can’t revoke this token.', 403);
    db.prepare('DELETE FROM mcp_token_spaces WHERE token_id = ? AND space_id = ?').run(r.id, spaceId);
    return;
  }
  if (r.user_id !== userId && !isSpaceOwner(getRecord<SpaceRecord>('space', r.space_id), userId)) throw new AiError('forbidden', 'You can’t revoke this token.', 403);
  db.prepare('UPDATE mcp_tokens SET revoked_time = ? WHERE id = ?').run(Date.now(), tokenId);
}

/** "Disconnect all users" (workspace owners): every connection loses the workspace. */
export function revokeAll(userId: string, spaceId: string): number {
  if (!isSpaceOwner(getRecord<SpaceRecord>('space', spaceId), userId)) throw new AiError('forbidden', 'Only workspace owners can disconnect everyone.', 403);
  return cutOff(spaceId, '1 = 1', []);
}

/** Workspaces the person can connect: member, and Litpage MCP is on there (with `clientKey`: the client is allowed). */
export function connectableSpaces(userId: string, clientKey?: string): SpaceRecord[] {
  const root = getRecord<UserRootRecord>('user_root', userId);
  const out: SpaceRecord[] = [];
  for (const id of root?.space_views ?? []) {
    const sv = getRecord<SpaceViewRecord>('space_view', id);
    if (!sv || sv.alive === false || sv.parent_id !== userId) continue;
    const s = getRecord<SpaceRecord>('space', sv.space_id);
    if (s && isSpaceMember(s, userId) && workspaceAiPolicy(s.id).litMcp && (clientKey === undefined || clientAllowed(s.id, userId, clientKey)) && !out.some((o) => o.id === s.id)) out.push(s);
  }
  return out;
}

/** Why the connection's client can't reach `spaceId` (null = it can). */
export function spaceProblem(spaceId: string, userId: string, clientKey: string): string | null {
  if (!isSpaceMember(getRecord<SpaceRecord>('space', spaceId), userId)) return 'You aren’t a member of this workspace.';
  if (!workspaceAiPolicy(spaceId).litMcp) return 'Litpage MCP is turned off for this workspace.';
  if (!clientAllowed(spaceId, userId, clientKey)) return CLIENT_NOT_APPROVED;
  return null;
}

/** Add workspaces to a connection (OAuth consent or Settings); skips the home and those already added. */
export function linkSpaces(tokenId: string, spaceIds: string[]) {
  const r = db.prepare('SELECT space_id, user_id, client_name FROM mcp_tokens WHERE id = ?').get(tokenId) as { space_id: string; user_id: string; client_name: string | null } | undefined;
  if (!r) return;
  const now = Date.now();
  for (const id of spaceIds) {
    if (id === r.space_id) continue;
    if (db.prepare('INSERT OR IGNORE INTO mcp_token_spaces (token_id, space_id, added_time) VALUES (?, ?, ?)').run(tokenId, id, now).changes) {
      audit('workspace_mcp_server_connected', { spaceId: id, actorId: r.user_id, targetId: tokenId, data: { client: r.client_name } });
    }
  }
}

export interface McpTokenWorkspace {
  id: string;
  name: string;
  icon: string | null;
  home: boolean;
  /** the connection reaches it */
  on: boolean;
  /** why it can't be added (null = it can) */
  problem: string | null;
}

function ownToken(userId: string, tokenId: string): TokenRow & { client_key: string | null; client_name: string | null } {
  const r = db.prepare('SELECT * FROM mcp_tokens WHERE id = ? AND revoked_time IS NULL').get(String(tokenId)) as (TokenRow & { client_key: string | null; client_name: string | null }) | undefined;
  if (!r || r.user_id !== userId) throw new AiError('not_found', 'That connection doesn’t exist.', 404);
  return r;
}

/** Settings › Litpage MCP › Workspaces: the person's workspaces and whether this connection reaches them. */
export function tokenWorkspaces(userId: string, tokenId: string): McpTokenWorkspace[] {
  const r = ownToken(userId, tokenId);
  const on = new Set(tokenSpaces(r.id, r.space_id, userId));
  const root = getRecord<UserRootRecord>('user_root', userId);
  const out: McpTokenWorkspace[] = [];
  for (const id of root?.space_views ?? []) {
    const sv = getRecord<SpaceViewRecord>('space_view', id);
    if (!sv || sv.alive === false || sv.parent_id !== userId) continue;
    const s = getRecord<SpaceRecord>('space', sv.space_id);
    if (!s || !isSpaceMember(s, userId) || out.some((o) => o.id === s.id)) continue;
    out.push({ id: s.id, name: s.name || 'Untitled workspace', icon: s.icon && s.icon.length <= 4 ? s.icon : null, home: s.id === r.space_id, on: on.has(s.id), problem: spaceProblem(s.id, userId, r.client_key ?? 'unknown') });
  }
  return out;
}

/**
 * Choose the workspaces a connection reaches (its person only). `homeSpaceId` makes another of them the main
 * workspace — where calls go that name no page or workspace; the old main one stays reached if it is in `spaceIds`.
 */
export function setTokenWorkspaces(userId: string, tokenId: string, spaceIds: string[], homeSpaceId?: string): McpTokenInfo {
  const r = ownToken(userId, tokenId);
  const home = homeSpaceId ? String(homeSpaceId) : r.space_id;
  const reached = new Set([r.space_id, ...(db.prepare('SELECT space_id FROM mcp_token_spaces WHERE token_id = ?').all(r.id) as { space_id: string }[]).map((x) => x.space_id)]);
  const want = [...new Set([home, ...spaceIds.map(String)])].slice(0, 50);
  for (const id of want) {
    if (reached.has(id) && id !== home) continue;
    const problem = spaceProblem(id, userId, r.client_key ?? 'unknown');
    if (problem) throw new AiError('forbidden', `${getRecord<SpaceRecord>('space', id)?.name || 'Workspace'}: ${problem}`, 403);
  }
  if (home !== r.space_id) {
    if (activeTokenCount(userId, home) >= MAX_TOKENS) throw new AiError('bad_request', `You can have up to ${MAX_TOKENS} active MCP connections in a workspace. Revoke one there first.`, 400);
    db.prepare('UPDATE mcp_tokens SET space_id = ? WHERE id = ?').run(home, r.id);
  }
  db.prepare('DELETE FROM mcp_token_spaces WHERE token_id = ?').run(r.id);
  const now = Date.now();
  for (const id of want) if (id !== home) db.prepare('INSERT INTO mcp_token_spaces (token_id, space_id, added_time) VALUES (?, ?, ?)').run(r.id, id, now);
  for (const id of want) {
    if (!reached.has(id)) audit('workspace_mcp_server_connected', { spaceId: id, actorId: userId, targetId: r.id, data: { client: r.client_name ?? null } });
  }
  return info(db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(r.id) as unknown as TokenRow);
}

// ---------------------------------------------------------------------------------------------
// MCP clients: catalog, approved list, who connected what

export interface McpCatalogClient {
  key: string;
  name: string;
  caption: string;
  match: RegExp;
}

/** MCP client catalog; matched against the name a client reports during initialize. */
export const MCP_CLIENT_CATALOG: McpCatalogClient[] = [
  { key: 'claude', name: 'Claude', caption: 'Ask Claude to work with your Litpage pages.', match: /^claude(ai)?\b|^claude[-_ .]|anthropic/i },
  { key: 'chatgpt', name: 'ChatGPT', caption: 'Bring Litpage notes into ChatGPT research.', match: /chatgpt|openai/i },
  { key: 'cursor', name: 'Cursor', caption: 'Find Litpage tasks and docs while you code.', match: /^cursor/i },
  { key: 'vscode', name: 'VS Code', caption: 'Give your coding workspace useful Litpage context.', match: /visual studio code|vs ?code/i },
  { key: 'figma-make', name: 'Figma Make', caption: 'Use Litpage requirements to start a Figma prototype.', match: /figma/i },
  { key: 'github', name: 'GitHub', caption: 'Link GitHub work to tasks in Litpage.', match: /github/i },
  { key: 'hubspot', name: 'HubSpot', caption: 'Keep HubSpot account notes alongside Litpage work.', match: /hubspot/i },
  { key: 'make', name: 'Make', caption: 'Build Make scenarios that update Litpage.', match: /^make(\.com)?\b/i },
  { key: 'microsoft', name: 'Microsoft 365 Copilot', caption: 'Use Litpage material in Microsoft 365 research.', match: /microsoft|m365|copilot/i },
  { key: 'mistral', name: 'Mistral', caption: 'Draft plans and database entries in Litpage.', match: /mistral|le chat/i },
  { key: 'perplexity', name: 'Perplexity', caption: 'Pair Litpage context with Perplexity answers.', match: /perplexity/i },
  { key: 'poke', name: 'Poke', caption: 'Let Poke reach the Litpage workspace you choose.', match: /^poke\b/i },
  { key: 'ramp-glass', name: 'Glass', caption: 'Give Glass Litpage context for everyday work.', match: /ramp|^glass\b/i },
  { key: 'zapier', name: 'Zapier', caption: 'Connect Litpage to Zapier automations.', match: /zapier/i },
  { key: 'composio', name: 'Composio', caption: 'Use Litpage in Composio workflows.', match: /composio/i },
  { key: 'devin', name: 'Devin', caption: 'Let Devin work with your Litpage workspace.', match: /devin/i },
];

/** The client behind a self-reported name: a catalog entry, or an unknown client keyed by its name. */
export function identifyClient(reported: string): { key: string; name: string; known: boolean } {
  const n = reported.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  const hit = n ? MCP_CLIENT_CATALOG.find((c) => c.match.test(n)) : undefined;
  if (hit) return { key: hit.key, name: hit.name, known: true };
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return slug ? { key: `custom:${slug}`, name: n, known: false } : { key: 'unknown', name: 'Unrecognized MCP client', known: false };
}

export interface ApprovedMcpClient {
  key: string;
  name: string;
  approved_by: string;
  approved_time: number;
}

export interface McpClientPolicy {
  /** "Approved MCP clients only" */
  restricted: boolean;
  approved: ApprovedMcpClient[];
  /** names chosen by an admin for this workspace (Rename) */
  names: Record<string, string>;
}

export function clientPolicy(space: SpaceRecord | undefined): McpClientPolicy {
  const st = (space?.settings ?? {}) as Record<string, unknown>;
  const approved = Array.isArray(st.mcp_clients_approved)
    ? (st.mcp_clients_approved as ApprovedMcpClient[]).filter((a) => a && typeof a.key === 'string').slice(0, 500)
    : [];
  const names = st.mcp_client_names && typeof st.mcp_client_names === 'object' ? (st.mcp_client_names as Record<string, string>) : {};
  return { restricted: st.mcp_clients_restricted === true, approved, names };
}

/** Persist the workspace's MCP client policy (space.settings, broadcast to members). */
export function saveClientPolicy(space: SpaceRecord, patch: Partial<McpClientPolicy>): SpaceRecord {
  const cur = clientPolicy(space);
  const next = { ...cur, ...patch };
  const settings = { ...(space.settings ?? {}), mcp_clients_restricted: next.restricted, mcp_clients_approved: next.approved, mcp_client_names: next.names };
  const saved = saveRecord('space', { ...space, settings }) as SpaceRecord;
  realtime.broadcastChanges([{ table: 'space', record: saved, spaceId: saved.id }] as never);
  return saved;
}

function tokenClient(tokenId: string): { key: string | null; name: string | null } {
  const r = db.prepare('SELECT client_key, client_name FROM mcp_tokens WHERE id = ?').get(tokenId) as { client_key: string | null; client_name: string | null } | undefined;
  return { key: r?.client_key ?? null, name: r?.client_name ?? null };
}

/** initialize: remember the client, audit its first connection, approve clients workspace owners connect. */
function noteClient(auth: McpAuth, clientInfo: unknown) {
  const reported = typeof (clientInfo as { name?: unknown } | undefined)?.name === 'string' ? String((clientInfo as { name: string }).name) : '';
  const before = db.prepare('SELECT client_key, client_name, first_connected_time, oauth_client_id FROM mcp_tokens WHERE id = ?').get(auth.tokenId) as { client_key: string | null; client_name: string | null; first_connected_time: number | null; oauth_client_id: string | null } | undefined;
  // an OAuth grant keeps the client it was authorized for, whatever initialize reports
  const id = before?.oauth_client_id && before.client_key ? { key: before.client_key, name: before.client_name ?? before.client_key } : identifyClient(reported);
  const now = Date.now();
  db.prepare('UPDATE mcp_tokens SET client_key = ?, client_name = ?, first_connected_time = COALESCE(first_connected_time, ?) WHERE id = ?').run(id.key, id.name, now, auth.tokenId);
  if (!before?.first_connected_time || before.client_key !== id.key) {
    audit('workspace_mcp_server_connected', { spaceId: auth.spaceId, actorId: auth.userId, targetId: auth.tokenId, data: { client: reported ? id.name : null } });
  }
  const space = getRecord<SpaceRecord>('space', auth.spaceId);
  if (space && isSpaceOwner(space, auth.userId)) {
    const pol = clientPolicy(space);
    if (!pol.approved.some((a) => a.key === id.key)) {
      saveClientPolicy(space, { approved: [...pol.approved, { key: id.key, name: id.name, approved_by: auth.userId, approved_time: now }] });
      audit('workspace_mcp_client_added_to_allowlist', { spaceId: auth.spaceId, actorId: auth.userId, data: { client: id.name, automatic: true } });
    }
  }
}

export const CLIENT_NOT_APPROVED = 'This MCP client isn’t approved for this workspace. Ask a workspace owner to add it to the approved MCP clients.';

/** "Approved MCP clients only" lets this person use the client with key `key` in the workspace. */
export function clientAllowed(spaceId: string, userId: string, key: string): boolean {
  const space = getRecord<SpaceRecord>('space', spaceId);
  const pol = clientPolicy(space);
  return !pol.restricted || isSpaceOwner(space, userId) || pol.approved.some((a) => a.key === key);
}

/**
 * Why calls from this token's client are blocked (null = allowed). For an access token the client is the name it
 * reported in initialize, which can't be verified, so "Approved MCP clients only" steers well-behaved clients — the
 * security boundary is the access token itself (its user's permissions, the workspace switch, revocation). An OAuth
 * grant is bound to the client the person authorized (its registered name, checked again at consent).
 */
function clientBlocked(auth: Pick<McpAuth, 'tokenId' | 'userId' | 'spaceId'>): string | null {
  return clientAllowed(auth.spaceId, auth.userId, tokenClient(auth.tokenId).key ?? 'unknown') ? null : CLIENT_NOT_APPROVED;
}

export interface McpClientRow {
  key: string;
  name: string;
  reportedName: string | null;
  caption: string | null;
  known: boolean;
  renamed: boolean;
  approved: boolean;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedTime: number | null;
  members: number;
  tokens: number;
  firstConnected: number | null;
  lastUsed: number | null;
  /** restricted and not approved: its calls don't work */
  blocked: boolean;
}

function requireAdmin(userId: string, spaceId: string): SpaceRecord {
  const space = getRecord<SpaceRecord>('space', spaceId);
  if (!space || !isSpaceOwner(space, userId)) throw new AiError('forbidden', 'Only workspace owners can manage MCP clients.', 403);
  return space;
}

/** Settings › MCP › All MCP clients: connected or approved clients with their members and last use. */
export function listClients(userId: string, spaceId: string): { restricted: boolean; clients: McpClientRow[] } {
  const space = requireAdmin(userId, spaceId);
  const pol = clientPolicy(space);
  const rows = db.prepare(`SELECT * FROM mcp_tokens WHERE ${REACHES} AND revoked_time IS NULL`).all(spaceId, spaceId) as unknown as (TokenRow & { client_key: string | null; client_name: string | null; first_connected_time: number | null })[];
  const byKey = new Map<string, McpClientRow>();
  const row = (key: string, reported: string | null): McpClientRow => {
    let r = byKey.get(key);
    if (!r) {
      const cat = MCP_CLIENT_CATALOG.find((c) => c.key === key);
      const ap = pol.approved.find((a) => a.key === key);
      r = {
        key, name: pol.names[key] || cat?.name || ap?.name || reported || 'Unrecognized MCP client', reportedName: reported, caption: cat?.caption ?? null, known: !!cat, renamed: !!pol.names[key],
        approved: !!ap, approvedBy: ap?.approved_by ?? null, approvedByName: ap ? getRecord<UserRecord>('lit_user', ap.approved_by)?.name ?? null : null, approvedTime: ap?.approved_time ?? null,
        members: 0, tokens: 0, firstConnected: null, lastUsed: null, blocked: false,
      };
      byKey.set(key, r);
    }
    return r;
  };
  const members = new Map<string, Set<string>>();
  for (const t of rows) {
    if (!t.client_key) continue;
    const r = row(t.client_key, t.client_name);
    r.tokens++;
    const set = members.get(t.client_key) ?? new Set<string>();
    set.add(t.user_id);
    members.set(t.client_key, set);
    if (t.first_connected_time && (!r.firstConnected || t.first_connected_time < r.firstConnected)) r.firstConnected = t.first_connected_time;
    if (t.last_used_time && (!r.lastUsed || t.last_used_time > r.lastUsed)) r.lastUsed = t.last_used_time;
  }
  for (const a of pol.approved) row(a.key, null);
  for (const [k, set] of members) byKey.get(k)!.members = set.size;
  const clients = [...byKey.values()].map((r) => ({ ...r, blocked: pol.restricted && !r.approved }));
  clients.sort((x, y) => (y.lastUsed ?? 0) - (x.lastUsed ?? 0) || x.name.localeCompare(y.name));
  return { restricted: pol.restricted, clients };
}

/** View members: who connected a client, first connected / last used. */
export function clientMembers(userId: string, spaceId: string, key: string) {
  requireAdmin(userId, spaceId);
  const rows = db.prepare(`SELECT * FROM mcp_tokens WHERE ${REACHES} AND client_key = ? AND revoked_time IS NULL ORDER BY last_used_time DESC`).all(spaceId, spaceId, key) as unknown as (TokenRow & { first_connected_time: number | null })[];
  const byUser = new Map<string, { userId: string; name: string; email: string | null; firstConnected: number | null; lastUsed: number | null; tokens: number }>();
  for (const t of rows) {
    const u = getRecord<UserRecord>('lit_user', t.user_id);
    const cur = byUser.get(t.user_id) ?? { userId: t.user_id, name: u?.name || u?.email || 'Unknown user', email: u?.email ?? null, firstConnected: null, lastUsed: null, tokens: 0 };
    cur.tokens++;
    if (t.first_connected_time && (!cur.firstConnected || t.first_connected_time < cur.firstConnected)) cur.firstConnected = t.first_connected_time;
    if (t.last_used_time && (!cur.lastUsed || t.last_used_time > cur.lastUsed)) cur.lastUsed = t.last_used_time;
    byUser.set(t.user_id, cur);
  }
  return [...byUser.values()];
}

/** Disconnect one member (or everyone,  per client) from a client: their tokens for it are revoked. */
export function disconnectClient(userId: string, spaceId: string, key: string, memberId?: string): number {
  requireAdmin(userId, spaceId);
  return memberId ? cutOff(spaceId, 'client_key = ? AND user_id = ?', [key, memberId]) : cutOff(spaceId, 'client_key = ?', [key]);
}

// Settings › MCP › Enabled clients › Disable: "{client} will no longer be able to access this workspace through
// your account" — the person's tokens connected with that client are revoked (reconnecting takes a new token). The
// settings list keys a few catalog clients differently from identifyClient.
const SETTINGS_CLIENT_KEYS: Record<string, string> = { figma: 'figma-make', glass: 'ramp-glass' };

export function disableMyClient(userId: string, spaceId: string, client: { id?: unknown; name?: unknown }): number {
  if (!isSpaceMember(getRecord<SpaceRecord>('space', spaceId), userId)) throw new AiError('forbidden', 'You aren’t a member of this workspace.', 403);
  const keys = new Set<string>();
  if (typeof client?.id === 'string' && client.id) keys.add(SETTINGS_CLIENT_KEYS[client.id] ?? client.id);
  if (typeof client?.name === 'string' && client.name.trim()) keys.add(identifyClient(client.name).key);
  keys.delete('unknown');
  if (!keys.size) return 0;
  const list = [...keys].slice(0, 5);
  return cutOff(spaceId, `user_id = ? AND client_key IN (${list.map(() => '?').join(', ')})`, [userId, ...list]);
}

/** "Approved MCP clients only" on/off. */
export function setClientRestriction(userId: string, spaceId: string, restricted: boolean) {
  const space = requireAdmin(userId, spaceId);
  saveClientPolicy(space, { restricted });
  audit(restricted ? 'workspace_mcp_allowlist_enabled' : 'workspace_mcp_allowlist_disabled', { spaceId, actorId: userId });
}

/** Approve MCP clients (catalog keys or connected clients' keys). */
export function approveClients(userId: string, spaceId: string, keys: string[]): number {
  const space = requireAdmin(userId, spaceId);
  const pol = clientPolicy(space);
  const known = new Map(listClients(userId, spaceId).clients.map((c) => [c.key, c.name]));
  const add: ApprovedMcpClient[] = [];
  for (const k of [...new Set(keys)].slice(0, 100)) {
    if (pol.approved.some((a) => a.key === k) || add.some((a) => a.key === k)) continue;
    const name = MCP_CLIENT_CATALOG.find((c) => c.key === k)?.name ?? known.get(k);
    if (!name) continue;
    add.push({ key: k, name, approved_by: userId, approved_time: Date.now() });
    audit('workspace_mcp_client_added_to_allowlist', { spaceId, actorId: userId, data: { client: name } });
  }
  if (add.length) saveClientPolicy(space, { approved: [...pol.approved, ...add] });
  return add.length;
}

export function removeApprovedClient(userId: string, spaceId: string, key: string) {
  const space = requireAdmin(userId, spaceId);
  const pol = clientPolicy(space);
  const gone = pol.approved.find((a) => a.key === key);
  if (!gone) return;
  saveClientPolicy(space, { approved: pol.approved.filter((a) => a.key !== key) });
  audit('workspace_mcp_client_removed_from_allowlist', { spaceId, actorId: userId, data: { client: pol.names[key] || gone.name } });
}

/** Rename a client for this workspace (custom or unknown clients); empty name restores the default. */
export function renameClient(userId: string, spaceId: string, key: string, name: string) {
  const space = requireAdmin(userId, spaceId);
  const pol = clientPolicy(space);
  const clean = name.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60);
  const names = { ...pol.names };
  const before = names[key] ?? null;
  if (clean) names[key] = clean;
  else delete names[key];
  saveClientPolicy(space, { names, approved: pol.approved.map((a) => (a.key === key && clean ? { ...a, name: clean } : a)) });
  audit('workspace_mcp_client_renamed', { spaceId, actorId: userId, data: { client: clean || key, from: before } });
}

interface McpAuth {
  tokenId: string;
  userId: string;
  /** the workspace the connection was made in */
  spaceId: string;
  /** every workspace it reaches, home first */
  spaces: string[];
}

/** Why a personal access token (a MCP token) can't be used now, wherever it is used — /api/mcp or the public
 *  API: "Allow MCP" is off, or its client isn't approved (null = usable). */
export function personalTokenBlocked(auth: Pick<McpAuth, 'tokenId' | 'userId' | 'spaceId'>): string | null {
  if (isDemoMode()) return DEMO_MESSAGE;
  if (!workspaceAiPolicy(auth.spaceId).litMcp) return 'Litpage MCP is turned off for this workspace.';
  return clientBlocked(auth);
}

/** Bearer header → token (personal "lp_pat_…" or an unexpired OAuth "lp_oat_…" access token). */
function tokenAuth(header: string | undefined): McpAuth | null {
  const m = /^Bearer\s+(lp_(?:pat|oat)_[A-Za-z0-9_-]{20,})$/i.exec(header?.trim() ?? '');
  if (!m) return null;
  const r = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_time IS NULL').get(hash(m[1])) as TokenRow | undefined;
  if (!r || (r.expires_time != null && r.expires_time <= Date.now())) return null;
  if (!isSpaceMember(getRecord<SpaceRecord>('space', r.space_id), r.user_id)) return null;
  db.prepare('UPDATE mcp_tokens SET last_used_time = ? WHERE id = ?').run(Date.now(), r.id);
  return { tokenId: r.id, userId: r.user_id, spaceId: r.space_id, spaces: tokenSpaces(r.id, r.space_id, r.user_id) };
}

/** Why calls of this connection can't work in `spaceId` (null = they can). */
function callProblem(auth: McpAuth, spaceId: string): string | null {
  if (!workspaceAiPolicy(spaceId).litMcp) return 'Litpage MCP is turned off for this workspace.';
  return clientAllowed(spaceId, auth.userId, tokenClient(auth.tokenId).key ?? 'unknown') ? null : CLIENT_NOT_APPROVED;
}

/** The workspaces calls of this connection can work in now. */
const usableSpaces = (auth: McpAuth) => auth.spaces.filter((id) => !callProblem(auth, id));

const ID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

/** String values of the arguments, nested ones too (parent: {type, id}, pages: [{…}]), in order. */
function argStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 100 || depth > 4) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) argStrings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) argStrings(x, out, depth + 1);
  return out;
}

/**
 * The workspace of the first page, database, team or workspace the arguments name (ids or Litpage URLs, anywhere in
 * the arguments) that this connection reaches.
 */
function spaceOfArgs(auth: McpAuth, args: Record<string, unknown>): string | null {
  for (const v of argStrings(args)) {
    for (const m of v.match(ID_RE) ?? []) {
      const id = expandId(m);
      if (auth.spaces.includes(id)) return id;
      const space = getRecord<BlockRecord>('block', id)?.space_id ?? getRecord<any>('collection', id)?.space_id ?? getRecord<TeamRecord>('team', id)?.space_id;
      if (space && auth.spaces.includes(space)) return space;
    }
  }
  return null;
}

/** The workspace a call works in: workspace_id (id or name), else the workspace of the page it names, else the home. */
function callSpace(auth: McpAuth, args: Record<string, unknown>): { spaceId: string } | { error: string } {
  const asked = typeof args.workspace_id === 'string' ? args.workspace_id.trim() : '';
  if (asked) {
    const want = asked.toLowerCase();
    const hit = auth.spaces.find((id) => id === asked) ?? auth.spaces.find((id) => (getRecord<SpaceRecord>('space', id)?.name ?? '').trim().toLowerCase() === want);
    if (!hit) return { error: `This connection can’t reach the workspace “${asked.slice(0, 80)}”. lit-get-self lists the workspaces it can reach; add more in Litpage under Settings → Litpage MCP.` };
    return { spaceId: hit };
  }
  return { spaceId: spaceOfArgs(auth, args) ?? auth.spaceId };
}

const WORKSPACE_ARG = { type: 'string', description: 'The workspace to work in: its id or name from lit-get-self. Leave it out to use the workspace of the page or database you name, or else the connection’s main workspace.' };

// ---------------------------------------------------------------------------------------------
// Tools (MCP names → agent registry)

interface McpToolDef {
  name: string;
  title: string;
  agent: string;
  readOnly: boolean;
  /** may overwrite content in a way the client should confirm (restoring a version) */
  destructive?: boolean;
  /** rename MCP argument names to the agent tool's */
  args?: Record<string, string>;
}

const MCP_TOOLS: McpToolDef[] = [
  { name: 'lit-search', title: 'Search Litpage', agent: 'search_workspace', readOnly: true },
  { name: 'lit-fetch', title: 'Fetch a page', agent: 'read_page', readOnly: true, args: { id: 'page_id' } },
  { name: 'lit-query-database', title: 'Query a database', agent: 'query_database', readOnly: true },
  { name: 'lit-get-comments', title: 'Get comments', agent: 'read_comments', readOnly: true },
  { name: 'lit-get-users', title: 'Get users', agent: 'list_people', readOnly: true },
  { name: 'lit-get-versions', title: 'Get page versions', agent: 'view_version_history', readOnly: true },
  { name: 'lit-create-pages', title: 'Create pages', agent: 'create_pages', readOnly: false },
  { name: 'lit-update-page', title: 'Update a page', agent: 'update_page', readOnly: false },
  { name: 'lit-update-rows', title: 'Update database rows', agent: 'update_rows', readOnly: false },
  { name: 'lit-manage-versions', title: 'Save or restore a version', agent: 'manage_versions', readOnly: false, destructive: true },
  { name: 'lit-move-pages', title: 'Move pages', agent: 'move_pages', readOnly: false },
  { name: 'lit-list-trash', title: 'List Trash', agent: 'list_trash', readOnly: true },
  { name: 'lit-restore-pages', title: 'Restore from Trash', agent: 'restore_pages', readOnly: false },
  { name: 'lit-create-database', title: 'Add a database', agent: 'create_database', readOnly: false },
  { name: 'lit-update-database', title: 'Update a database', agent: 'update_database', readOnly: false },
  { name: 'lit-create-linked-views', title: 'Create linked views', agent: 'create_linked_views', readOnly: false },
  { name: 'lit-create-comment', title: 'Create a comment', agent: 'add_comment', readOnly: false },
];

function schemaFor(t: McpToolDef): Record<string, unknown> {
  const def = TOOL_DEFS.find((d) => d.name === t.agent)!;
  if (!t.args) return def.input_schema;
  const props = { ...(def.input_schema.properties as Record<string, unknown>) };
  const required = [...((def.input_schema.required as string[]) ?? [])];
  for (const [mcpName, agentName] of Object.entries(t.args)) {
    props[mcpName] = { type: 'string', description: 'The page or database id, or its Litpage URL.' };
    delete props[agentName];
    const i = required.indexOf(agentName);
    if (i >= 0) required[i] = mcpName;
  }
  return { ...def.input_schema, properties: props, required };
}

/** The tools of a connection reaching `spaceIds`: memories and skills when any of them has them on. Every tool takes
 *  an optional workspace_id, so workspaces added to the connection later work without reconnecting. */
export function mcpToolList(spaceIds: string | string[]): Record<string, unknown>[] {
  const ids = Array.isArray(spaceIds) ? spaceIds : [spaceIds];
  const withWorkspace = (schema: Record<string, unknown>) => ({ ...schema, properties: { ...(schema.properties as Record<string, unknown> ?? {}), workspace_id: WORKSPACE_ARG } });
  const out: Record<string, unknown>[] = MCP_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: TOOL_DEFS.find((d) => d.name === t.agent)!.description,
    inputSchema: withWorkspace(schemaFor(t)),
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
  }));
  const none = { type: 'object', properties: {}, additionalProperties: false };
  out.push({ name: 'lit-get-self', title: 'Get self', description: 'Get the user this connection acts as, its main workspace and every workspace it can reach (pass one as workspace_id to the other tools).', inputSchema: none, annotations: { readOnlyHint: true } });
  // memory sync : the person's AI memories, shared with the agents they connect
  if (ids.some((id) => workspaceAiPolicy(id).memories)) {
    out.push({ name: 'lit-get-memories', title: 'Get memories', description: 'Get what the user asked Litpage AI to remember (their AI instructions page) so you can follow the same preferences.', inputSchema: withWorkspace(none), annotations: { readOnlyHint: true } });
    out.push({ name: 'lit-save-memory', title: 'Save a memory', description: 'Save something the user wants remembered across Litpage AI and the agents they connect (appended to their AI instructions page). Use it when the user states a lasting preference or fact about themselves or their work.', inputSchema: withWorkspace({ type: 'object', properties: { memory: { type: 'string', description: 'One short sentence to remember.' } }, required: ['memory'], additionalProperties: false }), annotations: { readOnlyHint: false, destructiveHint: false } });
  }
  if (ids.some((id) => workspaceAiPolicy(id).mcpSkills)) {
    out.push({ name: 'lit-list-skills', title: 'List skills', description: 'List the skills enabled for the user in Litpage (name, id, description). Use a skill when a task matches its description.', inputSchema: withWorkspace(none), annotations: { readOnlyHint: true } });
    out.push({ name: 'lit-get-skill', title: 'Get skill', description: 'Get the instructions of a skill by id.', inputSchema: withWorkspace({ type: 'object', properties: { skill_id: { type: 'string' } }, required: ['skill_id'], additionalProperties: false }), annotations: { readOnlyHint: true } });
  }
  return out;
}

async function callTool(conn: McpAuth, name: string, rawArgs: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });
  if (name === 'lit-get-self') {
    const u = getRecord<UserRecord>('lit_user', conn.userId);
    const s = getRecord<SpaceRecord>('space', conn.spaceId);
    const workspaces = usableSpaces(conn).map((id) => ({ id, name: getRecord<SpaceRecord>('space', id)?.name, main: id === conn.spaceId }));
    return text(JSON.stringify({ user: { id: u?.id, name: u?.name, email: u?.email }, workspace: { id: s?.id, name: s?.name }, workspaces }, null, 2));
  }
  const where = callSpace(conn, rawArgs);
  if ('error' in where) return text(where.error, true);
  const problem = callProblem(conn, where.spaceId);
  if (problem) return text(`${getRecord<SpaceRecord>('space', where.spaceId)?.name || 'Workspace'}: ${problem}`, true);
  const { workspace_id: _workspace, ...args } = rawArgs;
  void _workspace;
  const auth = { userId: conn.userId, spaceId: where.spaceId };
  if (name === 'lit-get-memories' || name === 'lit-save-memory') {
    if (!workspaceAiPolicy(auth.spaceId).memories) return text('Memories are turned off in this workspace.', true);
    const settings = (getRecord<UserSettingsRecord>('user_settings', auth.userId)?.settings ?? {}) as Record<string, unknown>;
    const pageId = typeof settings.ai_instructions_page === 'string' ? settings.ai_instructions_page : '';
    if (name === 'lit-get-memories') {
      const page = pageId ? getRecord<BlockRecord>('block', pageId) : undefined;
      // the token's workspace only (an instructions page in another workspace isn't this workspace's to share)
      if (!page || page.alive === false || page.space_id !== auth.spaceId || blockRole(page.id, auth.userId) === 'none') return text('No memories yet.');
      return text(pageToMarkdown(page.id, mdSource(auth.userId)).markdown.trim() || 'No memories yet.');
    }
    const memory = String(args.memory ?? '').trim();
    if (!memory) return text('Say what to remember in `memory`.', true);
    const env: AgentEnv = {
      userId: auth.userId, spaceId: auth.spaceId, threadId: null, turnId: `mcp-${newId()}`, currentPageId: null, approvalMode: 'skip_all', memories: true,
      cite: () => 0, step: () => {}, touched: () => {}, approve: async () => 'accept',
    };
    const r = await runTool(env, 'update_memory', { memory }, newId());
    return text(r.content, !!r.isError);
  }
  if (name === 'lit-list-skills' || name === 'lit-get-skill') {
    if (!workspaceAiPolicy(auth.spaceId).mcpSkills) return text('Skills through MCP are disabled in this workspace.', true);
    if (name === 'lit-list-skills') {
      const list = listSkills(auth.userId, auth.spaceId).enabled.filter((s) => !s.builtin);
      return text(list.length ? list.map((s) => `- ${s.name} (skill_id: ${s.id}): ${s.description || 'No description'}`).join('\n') : 'No skills are enabled.');
    }
    const s = skillById(String(args.skill_id ?? ''), auth.userId, auth.spaceId);
    return s ? text(`# ${s.name}\n\n${s.instructions}`) : text('That skill doesn’t exist or isn’t enabled.', true);
  }
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) return text(`Unknown tool ${name}.`, true);
  const input: Record<string, unknown> = { ...args };
  for (const [mcpName, agentName] of Object.entries(def.args ?? {})) {
    if (input[mcpName] !== undefined) {
      input[agentName] = input[mcpName];
      delete input[mcpName];
    }
  }
  const env: AgentEnv = {
    userId: auth.userId,
    spaceId: auth.spaceId,
    threadId: null,
    turnId: `mcp-${newId()}`,
    currentPageId: null,
    // MCP clients ask their own users before calling tools (tool annotations mark the writes)
    approvalMode: 'skip_all',
    memories: false,
    cite: () => 0,
    step: () => {},
    touched: () => {},
    approve: async () => 'accept',
  };
  // fetching a database id returns its rows
  let agent = def.agent;
  if (agent === 'read_page' && typeof input.page_id === 'string') {
    const b = getRecord<any>('block', String(input.page_id).trim());
    if (b && (b.type === 'collection_view_page' || b.type === 'collection_view') || getRecord('collection', String(input.page_id).trim())) {
      agent = 'query_database';
      input.database_id = input.page_id;
      delete input.page_id;
    }
  }
  const r = await runTool(env, agent, input, newId());
  return text(r.content.replace(/^Source \[\d+\]\n?/gm, ''), !!r.isError);
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

/** Handle one JSON-RPC message (null for notifications). */
async function handleMessage(auth: McpAuth, m: RpcMessage): Promise<Record<string, unknown> | null> {
  const id = m.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(-32600, 'Invalid Request');
  if (m.method.startsWith('notifications/')) return null;
  switch (m.method) {
    case 'initialize': {
      noteClient(auth, m.params?.clientInfo);
      const requested = String(m.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Litpage MCP', version: '1.0.0' },
        instructions: 'Tools act as the connected user in their Litpage workspaces: search and fetch pages, create and update pages and databases, restore pages from Trash, and comment. A connection can reach more than one workspace: lit-get-self lists them, and workspace_id picks one (by default the workspace of the page you name, else the main workspace).',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list': {
      const usable = usableSpaces(auth);
      if (!usable.length) return err(-32003, callProblem(auth, auth.spaceId) ?? CLIENT_NOT_APPROVED);
      return ok({ tools: mcpToolList(usable) });
    }
    case 'tools/call': {
      if (!usableSpaces(auth).length) return err(-32003, callProblem(auth, auth.spaceId) ?? CLIENT_NOT_APPROVED);
      const name = String(m.params?.name ?? '');
      const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
      return ok(await callTool(auth, name, args));
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return err(-32601, `Method not found: ${m.method}`);
  }
}

export interface McpHttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * POST /api/mcp — authenticate, rate limit, dispatch (single message or batch). `resourceMetadata`: URL of the
 * OAuth protected resource metadata, announced on 401 so MCP clients can start the OAuth flow (RFC 9728).
 */
export async function handleMcpHttp(authorization: string | undefined, body: unknown, sessionId?: string, resourceMetadata?: string): Promise<McpHttpResult> {
  if (isDemoMode()) return { status: 403, body: { jsonrpc: '2.0', id: null, error: { code: -32003, message: DEMO_MESSAGE } } };
  const auth = tokenAuth(authorization);
  if (!auth) {
    const challenge = ['realm="Litpage MCP"', ...(resourceMetadata ? [`resource_metadata="${resourceMetadata}"`] : []), ...(authorization ? ['error="invalid_token"'] : [])].join(', ');
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: sign in with OAuth or create an access token in Settings → Litpage MCP.' } }, headers: { 'www-authenticate': `Bearer ${challenge}` } };
  }
  if (!auth.spaces.some((id) => workspaceAiPolicy(id).litMcp)) return { status: 403, body: { jsonrpc: '2.0', id: null, error: { code: -32003, message: 'Litpage MCP is turned off for this workspace.' } } };
  if (!hit(`mcp:token:${auth.tokenId}`, Number(process.env.NC_MCP_RATE_PER_MIN) || 180, 60_000)) {
    return { status: 429, body: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'There are too many requests right now. Try again shortly.' } } };
  }
  const session = sessionId || newId();
  const msgs = Array.isArray(body) ? body.slice(0, 20) : [body];
  const out: Record<string, unknown>[] = [];
  for (const m of msgs) {
    const r = await handleMessage(auth, (m ?? {}) as RpcMessage);
    if (r) out.push(r);
  }
  if (!out.length) return { status: 202, headers: { 'mcp-session-id': session } };
  return { status: 200, body: Array.isArray(body) ? out : out[0], headers: { 'mcp-session-id': session } };
}
