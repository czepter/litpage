// Library › Trash tab: deleted pages and database entries of the workspace as a full-width table (page name, location,
// deleted by, deleted) with Restore / Permanently delete per row and the auto-delete retention note.
// Data: api('getTrashFiltered') (apps/server/src/api/modules/trash.ts), the same source as the sidebar Trash popover.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlockRecord, SpaceRecord } from '@nc/shared/records.ts';
import { trashRetentionDays } from '@nc/shared/retention.ts';
import { api } from '../../../lib/api.ts';
import { records } from '../../../lib/store/records.ts';
import { useSession } from '../../../lib/store/session.ts';
import { useUI } from '../../../lib/store/ui.ts';
import { openPage } from '../../../lib/router.ts';
import { Icon } from '../../../components/Icon.tsx';
import { PageIcon } from '../../shell/PageIcon.tsx';
import { confirmPermanentDelete } from '../../shell/TrashModal.tsx';
import { pageTitle, restorePage } from '../../page/pageActions.ts';
import { retentionDurationLabel } from '../../settings/spaceSettings.ts';
import { t } from '../../shell/i18n.ts';
import { LibAvatar } from './menus.tsx';
import { libraryTime, userName, userOf } from './model.ts';

interface Crumb { id: string; table: 'block' | 'team'; title: string }
interface TrashRow { id: string; path: Crumb[]; deletedTime?: number; canDelete: boolean }

export function TrashTab({ query }: { query: string }) {
  const spaceId = useSession((s) => s.spaceId);
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    const tm = setTimeout(() => {
      void api('getTrashFiltered', { spaceId, query, limit: 1000 })
        .then((res) => {
          if (id !== reqId.current) return;
          records.mergeRecordMap(res.recordMap);
          setRows(res.pages as TrashRow[]);
        })
        .catch(() => { if (id === reqId.current) setRows([]); });
    }, query ? 120 : 0);
    return () => clearTimeout(tm);
  }, [spaceId, query]);

  const doRestore = (id: string) => {
    restorePage(id);
    setRows((r) => (r ?? []).filter((x) => x.id !== id));
  };
  const doDelete = (id: string) => {
    confirmPermanentDelete(() => {
      void api('deleteBlocksPermanently', { blockIds: [id] })
        .then(() => setRows((r) => (r ?? []).filter((x) => x.id !== id)))
        .catch(() => useUI.getState().toast(t('lp.shell.couldn_t_delete_permanently_try_again', 'Couldn’t delete permanently. Try again later.')));
    });
  };

  const retention = useMemo(
    () => retentionDurationLabel(trashRetentionDays(records.get<SpaceRecord>('space', spaceId))),
    [spaceId],
  );

  if (rows && rows.length === 0 && !query) {
    return (
      <div className="nc-lib-empty">
        <div className="nc-lib-empty-icon"><Icon name="trash" size={32} /></div>
        <div className="nc-lib-empty-text">{t('lp.home.trash_empty', 'Trash is empty. Deleted pages and database entries show up here and can be restored.')}</div>
      </div>
    );
  }

  return (
    <div className="nc-lib-trash">
      <div className="nc-lib-trash-note">
        <Icon name="trash" size={16} />
        <span>{t('lp.home.trash_retention', 'Items in Trash are deleted automatically after {deleteFromTrashDelayString}.', { deleteFromTrashDelayString: retention })}</span>
      </div>
      <div className="lit-scroller horizontal nc-lib-body">
        <div className="nc-lib-table nc-lib-trash-table" role="table">
          <div className="nc-lib-trash-row head" role="row">
            <div className="nc-lib-trash-cell title" role="columnheader"><Icon name="libDocFill" size={16} /><span>{t('lp.home.page_name', 'Page name')}</span></div>
            <div className="nc-lib-trash-cell" role="columnheader"><Icon name="libLocationFill" size={16} /><span>{t('lp.home.trash_location', 'Location')}</span></div>
            <div className="nc-lib-trash-cell" role="columnheader"><Icon name="libUserCircleFill" size={16} /><span>{t('lp.home.deleted_by', 'Deleted by')}</span></div>
            <div className="nc-lib-trash-cell" role="columnheader"><Icon name="libClockFill" size={16} /><span>{t('lp.home.deleted', 'Deleted')}</span></div>
            <div className="nc-lib-trash-cell actions" role="columnheader" />
          </div>
          {rows && rows.length === 0 && <div className="nc-lib-empty-row">{t('lp.home.no_results', 'No results')}</div>}
          {(rows ?? []).map((row) => {
            const b = records.get<BlockRecord>('block', row.id);
            const u = userOf(b?.deleted_by_id || b?.last_edited_by_id);
            const path = row.path.map((c) => c.title || t('lp.home.untitled', 'Untitled')).join(' / ');
            return (
              <div key={row.id} className="nc-lib-trash-row" role="row" data-block-id={row.id}>
                <div className="nc-lib-trash-cell title" role="cell">
                  <div role="button" className="nc-lib-title" onClick={() => openPage(row.id)}>
                    <span className="nc-lib-title-icon"><PageIcon block={b} size={22} fallback={b?.type === 'collection_view_page' ? 'viewTable' : 'page'} /></span>
                    <span className="nc-lib-title-text notranslate">{pageTitle(b) || t('lp.home.untitled', 'Untitled')}</span>
                  </div>
                </div>
                <div className="nc-lib-trash-cell" role="cell"><span className="nc-ellipsis notranslate" title={path}>{path}</span></div>
                <div className="nc-lib-trash-cell nc-lib-person" role="cell">
                  {u && <><LibAvatar user={u} /><span className="nc-ellipsis notranslate">{userName(u)}</span></>}
                </div>
                <div className="nc-lib-trash-cell" role="cell">{libraryTime(row.deletedTime ?? b?.last_edited_time)}</div>
                <div className="nc-lib-trash-cell actions" role="cell">
                  <div role="button" className="nc-lib-trash-btn" aria-label={t('lp.shell.restore_page', 'Restore page')} data-tooltip={t('lp.shell.restore', 'Restore')} onClick={() => doRestore(row.id)}>
                    <Icon name="arrowUTurnUpLeft" size={16} />
                  </div>
                  <div
                    role="button"
                    className={`nc-lib-trash-btn ${row.canDelete ? '' : 'disabled'}`}
                    aria-label={t('lp.shell.permanently_delete', 'Permanently delete')}
                    aria-disabled={!row.canDelete || undefined}
                    data-tooltip={row.canDelete ? t('lp.shell.permanently_delete', 'Permanently delete') : t('lp.shell.you_can_t_permanently_delete_this', 'You can’t permanently delete this page')}
                    onClick={() => { if (row.canDelete) doDelete(row.id); }}
                  >
                    <Icon name="trashSmall" size={16} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
