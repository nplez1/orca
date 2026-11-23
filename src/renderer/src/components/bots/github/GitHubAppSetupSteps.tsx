// Steps 1–3 for putting an App in front of a bot's GitHub actions, in the order GitHub needs them.
import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { GitHubAppConnectForm } from './GitHubAppConnectForm'

export const GITHUB_APP_NEW_URL = 'https://github.com/settings/apps/new'
export const GITHUB_APP_LIST_URL = 'https://github.com/settings/apps'

function StepNumber({ value }: { value: string }): React.JSX.Element {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-2xs font-semibold text-muted-foreground">
      {value}
    </span>
  )
}

function Step({
  number,
  title,
  children
}: {
  number: string
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="space-y-2">
      <div className="flex items-center gap-2">
        <StepNumber value={number} />
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="space-y-2 pl-7">{children}</div>
    </li>
  )
}

/** One GitHub setting and the value to enter, in the order GitHub's form asks for them. */
function SettingRow({ name, detail }: { name: string; detail: string }): React.JSX.Element {
  return (
    <li className="px-3 py-2">
      <p className="text-xs font-medium">{name}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </li>
  )
}

function OpenPageButton({ url, label }: { url: string; label: string }): React.JSX.Element {
  return (
    <Button
      size="xs"
      variant="outline"
      data-link-url={url}
      onClick={(event) => void openAppHttpLink(url, { event })}
    >
      {label}
      <ExternalLink />
    </Button>
  )
}

export function GitHubAppSetupSteps({
  hostId,
  onConnected
}: {
  hostId: ExecutionHostId
  onConnected: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ol className="space-y-4">
      <Step number="1" title={t('bots.github.app.step.create', 'Create the App on GitHub')}>
        <OpenPageButton
          url={GITHUB_APP_NEW_URL}
          label={t('bots.github.app.step.createLink', 'Open GitHub’s new App page')}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.step.createOrg',
            'For an organization’s repositories, either create the App under that organization (https://github.com/organizations/<org>/settings/apps/new) or, when creating it under your personal account, choose “Any account” so the organization can install it. “Only on this account” cannot be installed on an organization.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('bots.github.app.step.createIntro', 'Fill the form in like this:')}
        </p>
        <ul className="divide-y divide-border rounded-md border border-border">
          <SettingRow
            name={t('bots.github.app.step.appName', 'App name')}
            detail={t(
              'bots.github.app.step.appNameValue',
              'Any name, for example “Orca bots”. GitHub turns it into the slug bots appear as: <slug>[bot].'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.homepage', 'Homepage URL')}
            detail={t(
              'bots.github.app.step.homepageValue',
              'Any URL you own — https://github.com/<you> is fine. Nothing reads it.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.webhook', 'Webhook')}
            detail={t(
              'bots.github.app.step.webhookValue',
              'Inactive. Nothing needs to reach Orca.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.installScope', 'Where can this App be installed?')}
            detail={t(
              'bots.github.app.step.installScopeValue',
              '“Only on this account” for your own repositories, “Any account” when an organization’s repositories are the ones the bots work in. GitHub offers only those two.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.permissions', 'Repository permissions')}
            detail={t(
              'bots.github.app.step.permissionsValue',
              'These five, and nothing else. Metadata: Read is added for you.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.pullRequests', 'Pull requests: Read and write')}
            detail={t(
              'bots.github.app.step.pullRequestsWhy',
              'Open pull requests, comment on them and review them.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.issues', 'Issues: Read and write')}
            detail={t('bots.github.app.step.issuesWhy', 'Comment on issues.')}
          />
          <SettingRow
            name={t('bots.github.app.step.contents', 'Contents: Read and write')}
            detail={t(
              'bots.github.app.step.contentsWhy',
              'Push commits and branches. Without it a push as the App is rejected.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.checks', 'Checks: Read')}
            detail={t(
              'bots.github.app.step.checksWhy',
              'See whether its own pull request is green.'
            )}
          />
          <SettingRow
            name={t('bots.github.app.step.actions', 'Actions: Read')}
            detail={t('bots.github.app.step.actionsWhy', 'Read a failed run’s logs.')}
          />
          <SettingRow
            name={t('bots.github.app.step.events', 'Which events would you like to subscribe to?')}
            detail={t('bots.github.app.step.eventsValue', 'None.')}
          />
        </ul>
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.step.optionalPermissions',
            'Leave Workflows: Read and write off. Orca does not request it, so a push that touches .github/workflows is rejected by GitHub until the App is given it on GitHub — grant it there if the bots push workflows.'
          )}
        </p>
      </Step>
      <Step
        number="2"
        title={t('bots.github.app.step.install', 'Install it on the repositories the bots work in')}
      >
        <OpenPageButton
          url={GITHUB_APP_LIST_URL}
          label={t('bots.github.app.step.installLink', 'Open your Apps')}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.step.installOrg',
            'An App owned by an organization is not on that page: open https://github.com/organizations/<org>/settings/apps for the organization instead.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.step.installNote',
            'On the App’s page, choose Install App, then the account and the repositories. All repositories works too: Orca shows which repositories the App covers, and Refresh picks up ones you add later.'
          )}
        </p>
      </Step>
      <Step number="3" title={t('bots.github.app.step.add', 'Add it to Orca')}>
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.step.addIntro',
            'On the App’s own settings page, copy the App ID and generate a private key.'
          )}
        </p>
        <GitHubAppConnectForm hostId={hostId} onConnected={onConnected} />
      </Step>
    </ol>
  )
}
