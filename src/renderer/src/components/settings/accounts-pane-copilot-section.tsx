import { ExternalLink, Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
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
    copilotConfigured,
    copilotCredentialBusy,
    saveCopilotCredentials,
    clearCopilotCredentials
  } = model
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
          copilotConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            copilotConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {copilotConfigured
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
            {translate(
              'auto.components.settings.accounts.pane.copilot.section.259e2dff8e',
              'Stored locally in the Orca encrypted credential store and sent to GitHub only to refresh your Copilot AI-credit usage.'
            )}
          </p>
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
            variant={copilotConfigured ? 'secondary' : 'outline'}
            className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
          >
            {copilotConfigured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            {copilotConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.2976a89a84',
                  'Saved'
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
            disabled={copilotCredentialBusy || (!copilotTokenDraft.trim() && !copilotConfigured)}
            className="h-7 shrink-0 text-xs"
          >
            {copilotCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {copilotConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.copilot.section.ef36dc11a9',
                  'Replace'
                )
              : translate(
                  'auto.components.settings.accounts.pane.copilot.section.b03cd42103',
                  'Save'
                )}
          </Button>
          {copilotConfigured ? (
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
            'auto.components.settings.accounts.pane.copilot.section.d0f786b0e5',
            'The token needs the “Enterprise billing” read permission. Orca cannot reuse the token the gh CLI stores, because that one cannot read these billing endpoints. Orca then refreshes the AI credits your enterprise consumes each month.'
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
            'auto.components.settings.accounts.pane.copilot.section.5a193f1da9',
            'The slug is the <slug> in github.com/enterprises/<slug>. Saving with the token field blank keeps your stored token, so the slug can be edited on its own. Forget token clears the slug as well.'
          )}
        </p>
      </SearchableSetting>
    </section>
  )
}
