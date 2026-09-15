import { Copy, Loader2, RefreshCw, ShieldCheck, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopilotIcon } from '../status-bar/icons'
import { Button } from '../ui/button'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { translate } from '@/i18n/i18n'

const COPILOT_TERMINAL_HEIGHT_PX = 240

export function renderCopilotAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    copilotGhStatus,
    copilotGhSetupHint,
    copilotCredentialBusy,
    copilotTerminalOpen,
    openCopilotTerminal,
    closeCopilotTerminal,
    recheckCopilotCredentials,
    copyCopilotGhSetupHint
  } = model
  const configured = copilotGhStatus === 'ok'
  // Why: the inline terminal needs a PTY on the machine that runs Orca, and the web
  // client's floating-terminal cwd resolves empty — there it would never finish starting.
  const isWebClient = isWebClientLocation()
  const hasSetupCommand = copilotGhSetupHint !== null
  const canRunSetupCommand = hasSetupCommand && !isWebClient

  return (
    <section key="copilot" id="accounts-copilot" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CopilotIcon size={16} />
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.dc3eaf8d70',
            'GitHub Copilot'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.ed307672cd',
            'Configure GitHub Copilot usage tracking for your account.'
          )}
        </p>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          configured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            configured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs font-medium">
              {copilotGhStatus === null
                ? translate(
                    'auto.components.settings.accounts.pane.copilot.section.536b94b44d',
                    'Checking...'
                  )
                : copilotGhStatus === 'ok'
                  ? translate(
                      'auto.components.settings.accounts.pane.copilot.section.ac2637c174',
                      'Signed in with the GitHub CLI'
                    )
                  : copilotGhStatus === 'gh-missing'
                    ? translate(
                        'auto.components.settings.accounts.pane.copilot.section.8ffce46573',
                        'GitHub CLI not found'
                      )
                    : copilotGhStatus === 'missing-scope'
                      ? translate(
                          'auto.components.settings.accounts.pane.copilot.section.6a85980a72',
                          'GitHub CLI sign-in needs the user scope'
                        )
                      : translate(
                          'auto.components.settings.accounts.pane.copilot.section.4fea97e088',
                          'Not signed in to GitHub'
                        )}
            </p>
            {copilotGhStatus === null ? (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {copilotGhStatus === null
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.d4a78cff5b',
                  'Reading the GitHub CLI status from this computer.'
                )
              : copilotGhStatus === 'ok'
                ? translate(
                    'auto.components.settings.accounts.pane.copilot.section.233569347b',
                    'Orca reads Copilot usage with your GitHub CLI sign-in. Nothing is saved in Orca.'
                  )
                : copilotGhStatus === 'gh-missing'
                  ? translate(
                      'auto.components.settings.accounts.pane.copilot.section.641d6ef0f2',
                      'Copilot usage is read through the GitHub CLI. Install gh, then sign in.'
                    )
                  : copilotGhStatus === 'missing-scope'
                    ? translate(
                        'auto.components.settings.accounts.pane.copilot.section.fa73ee648f',
                        'Grant the missing scope and Orca will start tracking your Copilot usage.'
                      )
                    : translate(
                        'auto.components.settings.accounts.pane.copilot.section.00ab515605',
                        'Sign in to the GitHub CLI and Orca will start tracking your Copilot usage.'
                      )}
          </p>
          {hasSetupCommand ? (
            <div className="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2">
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {copilotGhSetupHint}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={translate(
                  'auto.components.settings.accounts.pane.copilot.section.9e59104270',
                  'Copy command'
                )}
                onClick={() => void copyCopilotGhSetupHint()}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {isWebClient ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.6a15e5c762',
            'Set Copilot usage up from Orca on the computer where you use the GitHub CLI.'
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canRunSetupCommand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openCopilotTerminal}
              disabled={copilotTerminalOpen || copilotCredentialBusy}
            >
              <Terminal className="size-3.5" />
              {translate(
                'auto.components.settings.accounts.pane.copilot.section.67798c2fff',
                'Run setup command'
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => void recheckCopilotCredentials()}
            disabled={copilotCredentialBusy}
          >
            <RefreshCw className={cn('size-3.5', copilotCredentialBusy && 'animate-spin')} />
            {translate(
              'auto.components.settings.accounts.pane.copilot.section.91af911b56',
              'Re-check'
            )}
          </Button>
        </div>
      )}

      {canRunSetupCommand && copilotTerminalOpen ? (
        <OnboardingInlineCommandTerminal
          command={copilotGhSetupHint}
          title={translate(
            'auto.components.settings.accounts.pane.copilot.section.7874c1fb7a',
            'GitHub CLI setup'
          )}
          description={translate(
            'auto.components.settings.accounts.pane.copilot.section.a76d95b5f4',
            'Press Enter to run the command.'
          )}
          ariaLabel={translate(
            'auto.components.settings.accounts.pane.copilot.section.3eff016cff',
            'GitHub CLI setup terminal'
          )}
          terminalHeightPx={COPILOT_TERMINAL_HEIGHT_PX}
          terminalTopMarginPx={8}
          autoScrollIntoView={false}
          onCommandFinished={() => void recheckCopilotCredentials()}
          onTerminalExit={closeCopilotTerminal}
        />
      ) : null}
    </section>
  )
}
