// Settings › Connections: the connections this build supports (personal MCP servers, Litpage MCP, the developer
// platform) and the workspace connection controls.
import { useEffect, useState } from 'react';
import type { SpaceRecord, UserRecord } from '@nc/shared/records.ts';
import { api } from '../../../lib/api.ts';
import { records } from '../../../lib/store/records.ts';
import { useUI } from '../../../lib/store/ui.ts';
import { t } from '../../shell/i18n.ts';
import { Button, Group, Row, SectionPage, Switch, Upsell, UserAvatar, confirmDialog, msg, openSubDialog, rich } from '../ui.tsx';
import { planAtLeast, saveSpaceSettings, spaceSetting, useSpaceAccess } from '../spaceSettings.ts';
import { fmtDate } from './workspace.tsx';
import { useSettingsFocus } from '../searchIndex.ts';
import '../admin.css';
import { ApiConnectionsManage } from '../../developer/ManageConnections.tsx';
import { openDevelopers } from '../../developer/api.ts';
import { WorkspaceSharedMcps } from '../../ai/WorkspaceMcps.tsx';

/** "Personal MCP server" (Add connection menu / Developer connections): features/ai's Add custom MCP server dialog,
 *  when Connections › Manage › Turn on custom MCP servers is on (space.settings.ai_custom_mcp). */
function openCustomMcp(space: SpaceRecord | undefined, owner: boolean) {
  if (space && spaceSetting<boolean>(space, 'ai_custom_mcp', true) === false) {
    useUI.getState().toast(owner
      ? t('lp.settings.members_can_t_use_this_connection', 'Members can’t use this connection until custom MCP servers are switched on under Manage.')
      : t('lp.settings.custom_mcp_servers_are_off_in', 'Personal MCP servers are off in this workspace. Ask an owner to enable them.'));
    return;
  }
  void import('../../ai/dialogs.tsx').then((m) => m.openMcpConnectDialog());
}

export function ConnectionsSection() {
  const { space, owner } = useSpaceAccess();
  const focus = useSettingsFocus();
  const [tab, setTab] = useState<'browse' | 'manage'>(focus.section === 'connections' && focus.tab === 'manage' ? 'manage' : 'browse');
  useEffect(() => {
    if (focus.section === 'connections' && (focus.tab === 'manage' || focus.tab === 'browse')) setTab(focus.tab);
  }, [focus.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <SectionPage
      title={t('lp.settings.connections', 'Connections')}
      subtitle={
        <span className="nc-set-balanced">
          {t('lp.settings.connect_litpage_with_mcp_servers_and', 'Connect Litpage with MCP servers and your own integrations.')}
        </span>
      }
    >
      <div className="nc-set-connections">
        {owner && (
          <div className="nc-set-pills" role="tablist">
            <div role="tab" tabIndex={0} aria-selected={tab === 'browse'} className={`nc-set-pill big${tab === 'browse' ? ' selected' : ''}`} onClick={() => setTab('browse')}>{t('lp.settings.add_connection', 'Add connection')}</div>
            <div role="tab" tabIndex={0} aria-selected={tab === 'manage'} className={`nc-set-pill big${tab === 'manage' ? ' selected' : ''}`} onClick={() => setTab('manage')}>{t('lp.settings.manage', 'Manage')}</div>
          </div>
        )}
        {tab === 'manage' && space && owner ? <ManageConnections space={space} /> : (
          <Group>
            <Row
              id="custom-mcp-server"
              label={t('lp.settings.custom_mcp_server', 'Personal MCP server')}
              description={t('lp.settings.add_a_custom_mcp_server_connection', 'Add a custom MCP server connection')}
              control={<Button icon="integration" onClick={() => openCustomMcp(space, owner)}>{t('lp.settings.add', 'Add')}</Button>}
            />
            <Row
              id="litpage-mcp"
              label={t('lp.settings.litpage_mcp', 'Litpage MCP')}
              description={t('lp.settings.use_litpage_with_your_ai_tools', 'Use Litpage with your AI tools through a custom MCP connection:').replace(/:$/, '')}
              control={<Button onClick={() => useUI.getState().set({ settingsSection: 'lit-mcp' })}>{t('lp.settings.open', 'Open')}</Button>}
            />
            <Row
              id="develop-integrations"
              label={t('lp.settings.develop_integrations', 'Develop integrations')}
              description={t('lp.settings.build_integrations_with_the_litpage_api', 'Build integrations with the Litpage API and webhooks')}
              control={<Button icon="curlyBraces" onClick={() => { useUI.getState().set({ settingsOpen: false }); openDevelopers('connections'); }}>{t('lp.settings.open', 'Open')}</Button>}
            />
          </Group>
        )}
      </div>
    </SectionPage>
  );
}

// ---------------------------------------------------------------------------------------------- Manage (owners)

interface AdminConnection { id: string; userId: string; name: string; host: string; enabled: boolean; createdTime: number }
interface AdminToken { id: string; name: string; prefix: string; userId: string; createdTime: number; lastUsedTime: number | null }

function personName(id: string): string {
  const u = records.get<UserRecord>('lit_user', id);
  return u?.name || u?.email || '—';
}

/** Settings › Connections › Manage (workspace owners): every member's connections and personal access
 *  tokens (review / remove), and the connection permissions — webhook actions in automations (Enterprise, server-enforced
 *  by the automation engine through space.settings.disallow_webhook_automation_action) and custom MCP servers. */
function ManageConnections({ space }: { space: SpaceRecord }) {
  const [conns, setConns] = useState<AdminConnection[] | null>(null);
  const [tokens, setTokens] = useState<AdminToken[] | null>(null);
  const load = () => {
    api<{ connections: AdminConnection[]; recordMap: any }>('getWorkspaceConnections', { spaceId: space.id })
      .then((r) => { records.mergeRecordMap(r.recordMap); setConns(r.connections); })
      .catch(() => setConns([]));
    api<{ tokens: AdminToken[] }>('mcpListTokens', { spaceId: space.id, all: true }).then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
  };
  useEffect(load, [space.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = space.plan_type ?? 'plus';
  const enterprise = planAtLeast(plan, 'enterprise');
  const webhooksOn = spaceSetting<boolean>(space, 'disallow_webhook_automation_action', false) !== true;
  const customMcp = spaceSetting<boolean>(space, 'ai_custom_mcp', true) !== false;

  const openConnections = () => openSubDialog((close) => (
    <>
      <h3>{t('lp.settings.all_connections', 'All connections')}</h3>
      <div className="desc">{t('lp.settings.apps_that_workspace_members_have_connect', 'Apps that workspace members have connected')}</div>
      {conns?.length ? (
        <table className="nc-set-table" data-testid="all-connections">
          <thead><tr><th>{t('lp.settings.connection', 'Connection')}</th><th>{t('lp.settings.owner', 'Owner')}</th><th>{t('lp.settings.created_accf', 'Created')}</th><th style={{ width: 90 }} /></tr></thead>
          <tbody>
            {conns.map((c) => (
              <tr key={c.id}>
                <td className="primary">{c.name}{c.host ? <span className="mono"> · {c.host}</span> : null}</td>
                <td><span className="nc-set-person-inline"><UserAvatar user={records.get<UserRecord>('lit_user', c.userId)} size={20} />{personName(c.userId)}</span></td>
                <td>{fmtDate(c.createdTime)}</td>
                <td>
                  <Button small variant="ghost" onClick={async () => {
                    const ok = await confirmDialog({ title: t('lp.settings.remove_0ca7', 'Remove {clientName}?', { clientName: c.name }), confirmLabel: t('lp.settings.remove', 'Remove'), danger: true });
                    if (!ok) return;
                    try {
                      await api('removeWorkspaceConnection', { spaceId: space.id, connectionId: c.id });
                      setConns((list) => (list ?? []).filter((x) => x.id !== c.id));
                      close();
                    } catch (e) {
                      useUI.getState().toast((e as Error)?.message || t('lp.settings.something_went_wrong_while_processing_th', 'We hit a problem while processing that request.'));
                    }
                  }}>{t('lp.settings.remove', 'Remove')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="nc-set-empty">{t('lp.settings.no_connections_so_far', 'No connections so far')}</div>}
      <div className="actions"><Button onClick={close}>{t('lp.settings.close', 'Close')}</Button></div>
    </>
  ));

  const openTokens = () => openSubDialog((close) => (
    <>
      <h3>{t('lp.settings.every_personal_access_token', 'Every personal access token')}</h3>
      <div className="desc">{t('lp.settings.workspace_members_access_tokens', 'Workspace members’ access tokens')}</div>
      {tokens?.length ? (
        <table className="nc-set-table" data-testid="all-tokens">
          <thead><tr><th>{t('lp.settings.name', 'Name')}</th><th>{t('lp.settings.owner', 'Owner')}</th><th>{t('lp.settings.created_accf', 'Created')}</th><th>{t('lp.settings.last_used_f110', 'Last used')}</th><th style={{ width: 90 }} /></tr></thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id}>
                <td className="primary">{tk.name} <span className="mono">{tk.prefix}…</span></td>
                <td>{personName(tk.userId)}</td>
                <td>{fmtDate(tk.createdTime)}</td>
                <td>{tk.lastUsedTime ? fmtDate(tk.lastUsedTime) : t('lp.settings.text_1b93', '—')}</td>
                <td>
                  <Button small variant="ghost" onClick={async () => {
                    try {
                      await api('mcpRevokeToken', { tokenId: tk.id });
                      setTokens((list) => (list ?? []).filter((x) => x.id !== tk.id));
                      useUI.getState().toast(t('lp.settings.token_revoked', 'Token revoked'));
                      close();
                    } catch (e) {
                      useUI.getState().toast((e as Error)?.message || t('lp.settings.something_went_wrong_while_processing_th', 'We hit a problem while processing that request.'));
                    }
                  }}>{t('lp.settings.revoke', 'Revoke')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="nc-set-empty">{t('lp.settings.you_haven_t_made_any_tokens', 'You haven’t made any tokens yet')}</div>}
      <div className="actions"><Button onClick={close}>{t('lp.settings.close', 'Close')}</Button></div>
    </>
  ));

  return (
    <div className="nc-set-conn-manage">
      <Group title={t('lp.settings.oversee_connected_apps_and_tokens', 'Oversee connected apps and tokens')}>
        <Row
          id="all-connections"
          label={t('lp.settings.all_connections', 'All connections')}
          description={t('lp.settings.apps_that_workspace_members_have_connect', 'Apps that workspace members have connected')}
          control={(
            <span className="nc-set-btn-row">
              <span className="nc-set-count">{t('lp.settings.connections_ca9b', '{count} connections', { count: conns?.length ?? 0 })}</span>
              <Button onClick={openConnections}>{t('lp.settings.view_manage', 'View & manage')}</Button>
            </span>
          )}
        />
        <Row
          id="all-personal-access-tokens"
          label={t('lp.settings.every_personal_access_token', 'Every personal access token')}
          description={t('lp.settings.workspace_members_access_tokens', 'Workspace members’ access tokens')}
          control={(
            <span className="nc-set-btn-row">
              <span className="nc-set-count">{t('lp.settings.count_plural_one_other_a7a0', '{count, plural, one {# enabled access token} other {# enabled access tokens}}', { count: tokens?.length ?? 0 })}</span>
              <Button onClick={openTokens}>{t('lp.settings.view_manage', 'View & manage')}</Button>
            </span>
          )}
        />
      </Group>
      {/* the workspace's API connections with their ••• menu */}
      <ApiConnectionsManage />
      {/* Workspace shared MCPs */}
      <WorkspaceSharedMcps space={space} />
      <Group title={t('lp.settings.manage_permissions', 'Manage permissions')}>
        <Row
          id="allow-webhook-actions"
          label={t('lp.settings.allow_automations_to_run_webhook_actions', 'Allow automations to run webhook actions')}
          description={(
            <>
              {rich(msg('lp.settings.decide_who_can_use_the_send', 'Decide who can use the <bold>Send webhook</bold> action in buttons and automations'), {}, { bold: (c) => <b>{c}</b> })}
              {!enterprise && <Upsell text={msg('lp.settings.upgrade_to_block_database_automations_an', '<highlight>Upgrade</highlight> to block database automations and buttons from sending webhooks to third-party tools')} />}
            </>
          )}
          control={<Switch label="Permit webhooks in automations" checked={webhooksOn} disabled={!enterprise} onChange={(v) => saveSpaceSettings(space.id, { disallow_webhook_automation_action: !v })} />}
        />
        <Row
          id="custom-mcp-servers"
          label={t('lp.settings.turn_on_custom_mcp_servers', 'Turn on custom MCP servers')}
          description={t('lp.settings.members_can_link_agents_to_custom', 'Members can link agents to custom MCP servers not reviewed by Litpage. Through those servers, agents can send content outside, pull in external data, and act in other systems.')}
          control={<Switch label="Turn on custom MCP servers" checked={customMcp} onChange={(v) => saveSpaceSettings(space.id, { ai_custom_mcp: v })} />}
        />
      </Group>
    </div>
  );
}
