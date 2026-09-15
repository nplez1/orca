import { Check, Copy, ExternalLink, Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopilotIcon } from '../status-bar/icons'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { translate } from '@/i18n/i18n'

// Why: enterprise billing is a fine-grained permission, so the classic-token page cannot mint one.
const GITHUB_FINE_GRAINED_TOKENS_URL = 'https://github.com/settings/tokens?type=beta'

export function renderCopilotAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    copilotTokenDraft,
    setCopilotTokenDraft,
    copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft,
    copilotCredentialSource,
    copilotGhSetupHint,
    copilotGhSetupHintCopied,
    copyCopilotGhSetupHint,
    copilotCredentialBusy,
    saveCopilotCredentials,
    clearCopilotCredentials
  } = model
  // Why: a credential sourced from the GitHub CLI has nothing stored to replace or
  // forget, so every stored-token affordance keys off the source, not `configured`.
  const tokenStored = copilotCredentialSource === 'stored'
  const usingGithubCli = copilotCredentialSource === 'github-cli'
  const credentialMissing = copilotCredentialSource === 'none'
  return (
    <section key="copilot" id="accounts-copilot" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
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
        <a
          href={GITHUB_FINE_GRAINED_TOKENS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.f8bb20c24c',
            'Open console'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          credentialMissing ? 'border-border/40' : 'border-border/60'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            credentialMissing ? 'text-muted-foreground' : 'text-foreground'
          )}
        />
        <div className="space-y-1">
          <p className="text-xs font-medium">
            {usingGithubCli
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.6a27446bd3',
                  'Using your GitHub CLI sign-in'
                )
              : tokenStored
                ? translate(
                    'auto.components.settings.accounts.pane.copilot.section.886fc8ca30',
                    'Stored locally'
                  )
                : translate(
                    'auto.components.settings.accounts.pane.copilot.section.d5f964d2ec',
                    'Credentials not set'
                  )}
          </p>
          <p className="text-xs text-muted-foreground">
            {usingGithubCli
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.233569347b',
                  'Orca reads Copilot usage with your GitHub CLI sign-in. Nothing is saved in Orca.'
                )
              : translate(
                  'auto.components.settings.accounts.pane.copilot.section.259e2dff8e',
                  'Stored locally in the Orca encrypted credential store and sent to GitHub only to refresh your Copilot AI-credit usage.'
                )}
          </p>
          {usingGithubCli ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.accounts.pane.copilot.section.467c761749',
                'Enterprise slug'
              )}
              {': '}
              <span className="font-mono text-xs text-foreground">
                {copilotEnterpriseSlugDraft}
              </span>
            </p>
          ) : null}
          {copilotGhSetupHint ? (
            <div className="space-y-1.5 pt-1">
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.accounts.pane.copilot.section.f1c1fd4ffb',
                  'Run this to finish setting up the GitHub CLI for Copilot billing:'
                )}
              </p>
              <div className="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                  {copilotGhSetupHint}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0 gap-1.5"
                  aria-label={
                    copilotGhSetupHintCopied
                      ? translate(
                          'auto.components.settings.accounts.pane.copilot.section.6a327922f7',
                          'Copied'
                        )
                      : translate(
                          'auto.components.settings.accounts.pane.copilot.section.9e59104270',
                          'Copy command'
                        )
                  }
                  onClick={() => void copyCopilotGhSetupHint()}
                >
                  {copilotGhSetupHintCopied ? (
                    <>
                      <Check className="size-3" />
                      {translate(
                        'auto.components.settings.accounts.pane.copilot.section.6a327922f7',
                        'Copied'
                      )}
                    </>
                  ) : (
                    <Copy className="size-3" />
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.copilot.section.7e6b3de4ea',
          'GitHub token'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.copilot.section.4d5c01e15c',
          'Paste a GitHub token that can read enterprise billing and the slug it belongs to.'
        )}
        keywords={['copilot', 'github', 'token', 'enterprise billing', 'ai credits', 'usage']}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="copilot-token">
            {translate(
              'auto.components.settings.accounts.pane.copilot.section.7e6b3de4ea',
              'GitHub token'
            )}
          </Label>
          <Badge
            variant={tokenStored ? 'secondary' : 'outline'}
            className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
          >
            {tokenStored ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            {tokenStored
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.2976a89a84',
                  'Saved'
                )
              : usingGithubCli
                ? translate(
                    'auto.components.settings.accounts.pane.copilot.section.ae9c8d3fd2',
                    'Optional override'
                  )
                : translate(
                    'auto.components.settings.accounts.pane.copilot.section.13ae4d0b21',
                    'Not saved'
                  )}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Input
            id="copilot-token"
            type="password"
            disabled={copilotCredentialBusy}
            value={copilotTokenDraft}
            onChange={(e) => setCopilotTokenDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.accounts.pane.copilot.section.74858f3994',
              'Paste your GitHub token'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveCopilotCredentials()}
            disabled={copilotCredentialBusy || (!copilotTokenDraft.trim() && !tokenStored)}
            className="h-7 shrink-0 text-xs"
          >
            {copilotCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {tokenStored
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.ef36dc11a9',
                  'Replace'
                )
              : translate(
                  'auto.components.settings.accounts.pane.copilot.section.b03cd42103',
                  'Save'
                )}
          </Button>
          {tokenStored ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearCopilotCredentials()}
              disabled={copilotCredentialBusy}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {translate(
                'auto.components.settings.accounts.pane.copilot.section.4cf256a883',
                'Forget token'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.022c7c89d5',
            'Orca prefers your GitHub CLI sign-in, which needs the manage_billing:enterprise scope to discover an enterprise and read its billing data. Paste a token only for accounts that sign-in cannot serve. The token needs the “Enterprise billing” read permission. Orca then refreshes the AI credits your enterprise consumes each month.'
          )}
        </p>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.copilot.section.467c761749',
          'Enterprise slug'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.copilot.section.fa8def1ab4',
          'Required. The slug selects which enterprise Orca reads GitHub Copilot usage from.'
        )}
        keywords={['copilot', 'github', 'enterprise', 'slug', 'billing']}
        className="space-y-2"
      >
        <Label htmlFor="copilot-enterprise-slug">
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.467c761749',
            'Enterprise slug'
          )}
        </Label>
        <Input
          id="copilot-enterprise-slug"
          type="text"
          disabled={copilotCredentialBusy}
          value={copilotEnterpriseSlugDraft}
          onChange={(e) => setCopilotEnterpriseSlugDraft(e.target.value)}
          placeholder={translate(
            'auto.components.settings.accounts.pane.copilot.section.d7c06dead5',
            'your-enterprise'
          )}
          spellCheck={false}
          className="text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.copilot.section.1006eed696',
            'The slug is the <slug> in github.com/enterprises/<slug>.'
          )}
          {tokenStored || usingGithubCli ? (
            <>
              {' '}
              {tokenStored
                ? translate(
                    'auto.components.settings.accounts.pane.copilot.section.3c8314c1de',
                    'Saving with the token field blank keeps your stored token, so the slug can be edited on its own. Forget token clears the slug as well.'
                  )
                : translate(
                    'auto.components.settings.accounts.pane.copilot.section.06fb320a51',
                    'Detected from your GitHub CLI sign-in. Paste a token to override it.'
                  )}
            </>
          ) : null}
        </p>
      </SearchableSetting>
    </section>
  )
}
