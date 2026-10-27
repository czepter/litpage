import { HELP_URL } from '@nc/shared/brand.ts';
// Settings › Notifications.
import { useCurrentSpaceView } from '../../../lib/hooks.ts';
import { Icon } from '../../../components/Icon.tsx';
import { t } from '../../shell/i18n.ts';
import { Button, Group, Row, SectionPage, Switch, msg, rich } from '../ui.tsx';
import { prefValue, savePref, saveSpaceViewFields, usePrefs } from '../userSettings.ts';

export function NotificationsSection() {
  const prefs = usePrefs();
  const sv = useCurrentSpaceView();
  const emailOn = sv?.notify_email !== false && prefValue(prefs, 'email_activity');
  return (
    <SectionPage title={t('lp.settings.notifications', 'Notifications')} subtitle={t('lp.settings.choose_when_and_how_to_get', 'Choose when and how to get notifications')}>
      <Group title={t('lp.settings.notifications_in_litpage', 'Notifications in Litpage')}>
        <Row
          label={t('lp.settings.transcribing_the_meeting', 'Transcribing the meeting')}
          description={t('lp.settings.show_a_popup_while_ai_meeting', 'Show a popup while AI meeting notes transcribe a meeting')}
          control={<Switch label="Transcribing the meeting" checked={prefValue(prefs, 'notify_meeting_transcribed')} onChange={(v) => savePref('notify_meeting_transcribed', v)} />}
        />
      </Group>

      <Group title={t('lp.settings.email_notifications', 'Email notifications')}>
        <Row
          label={t('lp.settings.my_workspace_activity', 'My workspace activity')}
          description={t('lp.settings.receive_email_for_new_comments_and', 'Receive email for new comments and mentions, page invitations, reminders, requests for access, and changes to database properties')}
          control={<Switch label="Activity in this workspace" checked={emailOn} onChange={(v) => { savePref('email_activity', v); saveSpaceViewFields({ notify_email: v }); }} />}
        />
        <Row
          label={t('lp.settings.always_notify_me_by_email', 'Always notify me by email')}
          description={t('lp.settings.keep_getting_activity_emails_even_while', 'Keep getting activity emails even while you’re using Litpage')}
          control={<Switch label="Send email notifications every time" checked={prefValue(prefs, 'email_always')} onChange={(v) => savePref('email_always', v)} />}
        />
        <Row
          label={t('lp.settings.page_updates', 'Page updates')}
          description={rich(msg('lp.settings.get_email_digests_for_pages_where', 'Get email digests for pages where you’ve <inlinelink>enabled notifications</inlinelink> and pages you created'), {}, {
            inlinelink: (c) => HELP_URL ? <a href={HELP_URL} target="_blank" rel="noreferrer">{c}</a> : c,
          })}
          control={<Switch label="Page updates" checked={prefValue(prefs, 'email_page_updates')} onChange={(v) => savePref('email_page_updates', v)} />}
        />
        <Row
          label={t('lp.settings.workspace_digest', 'Workspace digest')}
          description={t('lp.settings.receive_a_regular_email_roundup_of', 'Receive a regular email roundup of workspace activity')}
          control={<Switch label="Workspace digest" checked={prefValue(prefs, 'email_workspace_digest')} onChange={(v) => savePref('email_workspace_digest', v)} />}
        />
        <Row
          label={t('lp.settings.emails_about_product_news_and_updates', 'Emails about product news and updates')}
          description={t('lp.settings.occasionally_email_me_about_new_litpage', 'Occasionally email me about new Litpage features')}
          control={HELP_URL ? <Button icon="arrowDiagonalUpRightSmall" onClick={() => window.open(HELP_URL!, '_blank')}>{t('lp.settings.manage_settings', 'Manage settings')}</Button> : null}
        />
      </Group>
      {HELP_URL && <a className="nc-set-help-link" href={HELP_URL} target="_blank" rel="noreferrer">
        <Icon name="questionMarkCircleSmall" size={16} />
        {t('lp.settings.notification_guide', 'Notification guide')}
      </a>}
    </SectionPage>
  );
}
