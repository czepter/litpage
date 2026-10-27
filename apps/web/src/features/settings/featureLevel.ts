// Feature levels (Free, Pro, Business, Enterprise) are set for the whole install with NC_FEATURE_LEVEL on the server.
// Plan-gated hints point there instead of offering an upgrade: Litpage is self-hosted and has no billing.
import { useUI } from '../../lib/store/ui.ts';
import { t } from '../shell/i18n.ts';

export function showFeatureLevelHint() {
  useUI.getState().toast(t('lp.settings.feature_level_is_set_by_the', 'The feature level is set by whoever runs this server (NC_FEATURE_LEVEL).'));
}
