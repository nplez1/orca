// Settings › Bots: the optional GitHub App a computer's bots act as, so their comments, reviews and pull
// requests are authored by `<slug>[bot]` instead of by whoever is signed in to `gh`.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { githubAppCalls, githubAppErrorMessage, type GithubAppView } from '@/lib/github-app-client'
import { GITHUB_APP_BOT_SUFFIX } from '../../../../../shared/github/app/github-app-identity'
import type {
  GithubAppInstallationView,
  GithubAppStatus
} from '../../../../../shared/rpc-contract/github/github-app-params'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { GitHubAppSetupSteps } from './GitHubAppSetupSteps'

/** Where the App's own page installs it on more repositories. */
function installUrl(login: string): string {
  const slug = login.toLowerCase().endsWith(GITHUB_APP_BOT_SUFFIX)
    ? login.slice(0, -GITHUB_APP_BOT_SUFFIX.length)
    : login
  return `https://github.com/apps/${slug}/installations/new`
}

function InstallationRow({
  installation,
  active
}: {
  installation: GithubAppInstallationView
  active: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <li className="px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        {installation.account}
        {active ? (
          <span className="rounded-sm border border-border px-1 text-2xs text-muted-foreground">
            {t('bots.github.app.inUse', 'In use')}
          </span>
        ) : null}
      </p>
      <p className="text-xs break-words text-muted-foreground">
        {installation.repositorySelection === 'all'
          ? t('bots.github.app.allRepositories', 'All repositories')
          : installation.repositories.join(', ')}
      </p>
    </li>
  )
}

function ConnectedApp({
  hostId,
  app,
  onChanged
}: {
  hostId: ExecutionHostId
  app: Extract<GithubAppStatus, { connected: true }>
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const expiresAt = app.tokenExpiresAt ? new Date(app.tokenExpiresAt) : null
  const inUse = app.installations.find(
    (installation) => installation.id === app.activeInstallationId
  )

  /** A repository added on GitHub, or a second installation, without pasting the key again. */
  const refresh = (): void => {
    setBusy(true)
    setError(null)
    void githubAppCalls(hostId)
      .refresh()
      .then(onChanged, (caught: unknown) => {
        setError(
          githubAppErrorMessage(caught) ??
            t('bots.github.app.refreshFailed', 'Could not re-read the App from GitHub.')
        )
      })
      .finally(() => setBusy(false))
  }

  const disconnect = (): void => {
    setBusy(true)
    setError(null)
    void githubAppCalls(hostId)
      .disconnect()
      .then(onChanged, (caught: unknown) => {
        setError(
          githubAppErrorMessage(caught) ??
            t('bots.github.app.disconnectFailed', 'Could not disconnect the App.')
        )
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <div className="rounded-md border border-border">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm">{app.login}</p>
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.github.app.connectedAs',
                'Bots act on GitHub as this App, not as your GitHub account.'
              )}
            </p>
            {inUse ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  'bots.github.app.activeInstallation',
                  'Bots act through the installation on {{account}}.',
                  { account: inUse.account }
                )}
              </p>
            ) : null}
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            data-link-url={installUrl(app.login)}
            onClick={(event) => void openAppHttpLink(installUrl(app.login), { event })}
          >
            {t('bots.github.app.addRepositories', 'Add repositories')}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={refresh}>
            {t('bots.github.app.refresh', 'Refresh')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={disconnect}>
            {t('bots.github.app.disconnect', 'Disconnect')}
          </Button>
        </div>
        <ul className="divide-y divide-border border-t border-border">
          {app.installations.map((installation) => (
            <InstallationRow
              key={installation.id}
              installation={installation}
              active={installation.id === app.activeInstallationId}
            />
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.github.app.githubComOnly',
          'The App’s token is for github.com. On a GitHub Enterprise host a bot’s gh keeps acting as your own sign-in.'
        )}
      </p>
      {inUse && inUse.canPush === false ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'bots.github.app.contentsMissing',
            'This installation has no Contents: write, so a push as the App will be rejected. Give the App that permission on GitHub, then Refresh.'
          )}
        </p>
      ) : null}
      {inUse && inUse.canPush === null ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.contentsUnknown',
            'Orca has not read this installation’s permissions yet, so it cannot tell whether a push as the App will be allowed. Refresh to read them.'
          )}
        </p>
      ) : null}
      {inUse && inUse.canPushWorkflows === true ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.workflowsWrite',
            'This installation also has Workflows: write, so a push as the App can change .github/workflows.'
          )}
        </p>
      ) : null}
      {inUse && inUse.canPushWorkflows === false ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'bots.github.app.workflowsMissing',
            'This installation has no Workflows: write, so a push that changes .github/workflows is refused. Grant it on GitHub, then Refresh.'
          )}
        </p>
      ) : null}
      {expiresAt ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.tokenExpires',
            'A token it minted expires at {{time}}. Bots mint a new one when it does.',
            {
              time: uiDateTimeFormat({ hour: 'numeric', minute: 'numeric' }, intlLocale).format(
                expiresAt
              )
            }
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}

/**
 * Settings › Bots: the App a host's bots act as, or the three steps that put one there. Optional — with
 * none connected, everything keeps using the signed-in `gh` account.
 */
export function GitHubAppSettings({
  hostId,
  hostName,
  appRead
}: {
  hostId: ExecutionHostId
  hostName: string | null
  /** The read its group already made, so the row above and this panel never disagree. */
  appRead: { view: GithubAppView; reload: () => void }
}): React.JSX.Element | null {
  const t = useTranslate()
  const { view, reload } = appRead
  const connected = view.status === 'ready' && view.value.connected ? view.value : null
  const header = (
    <SettingsSubsectionHeader
      title={t('bots.github.app.title', 'GitHub App')}
      description={
        connected
          ? t(
              'bots.github.app.descriptionConnected',
              'Your bots act on GitHub as {{login}}, so their comments, reviews and pull requests are theirs.',
              { login: connected.login }
            )
          : hostName
            ? t(
                'bots.github.app.descriptionOnHost',
                'Optional. Let the bots on {{host}} act on GitHub as an App you own, instead of as your GitHub account.',
                { host: hostName }
              )
            : t(
                'bots.github.app.description',
                'Optional. Let your bots act on GitHub as an App you own, instead of as your GitHub account.'
              )
      }
    />
  )
  if (view.status === 'loading') {
    return <section className="space-y-3">{header}</section>
  }
  if (view.status === 'unavailable') {
    return null
  }
  if (view.status === 'failed') {
    return (
      <section className="space-y-3">
        {header}
        <div className="flex items-center gap-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {githubAppErrorMessage(view.error) ??
              (hostName
                ? t(
                    'bots.github.app.readFailedOnHost',
                    'Could not read the GitHub App on {{host}}.',
                    { host: hostName }
                  )
                : t(
                    'bots.github.app.readFailed',
                    'Could not read the GitHub App on this computer.'
                  ))}
          </p>
          <Button size="xs" variant="outline" onClick={reload}>
            {t('bots.github.app.retry', 'Try again')}
          </Button>
        </div>
      </section>
    )
  }
  if (connected) {
    return (
      <section className="space-y-3">
        {header}
        <ConnectedApp hostId={hostId} app={connected} onChanged={reload} />
      </section>
    )
  }
  const app = view.value
  return (
    <section className="space-y-3">
      {header}
      {!app.connected && app.unreadable ? (
        <p role="alert" className="text-xs text-destructive">
          {app.unreadable}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.github.app.optional',
          'Orca and its bots keep using your signed-in gh account as they do today. Adding an App only changes who a bot’s GitHub actions are authored by.'
        )}
      </p>
      <GitHubAppSetupSteps hostId={hostId} onConnected={reload} />
    </section>
  )
}
