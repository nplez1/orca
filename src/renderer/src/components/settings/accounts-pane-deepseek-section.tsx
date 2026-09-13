import { ExternalLink, Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DeepSeekIcon } from '../status-bar/icons'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { translate } from '@/i18n/i18n'

const DEEPSEEK_CONSOLE_URL = 'https://platform.deepseek.com/usage'

export function renderDeepSeekAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    deepSeekApiKeyDraft,
    setDeepSeekApiKeyDraft,
    deepSeekApiKeyConfigured,
    deepSeekCredentialBusy,
    saveDeepSeekApiKey,
    clearDeepSeekApiKey
  } = model
  return (
    <section key="deepseek" id="accounts-deepseek" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <DeepSeekIcon size={16} />
            {translate(
              'auto.components.settings.accounts.pane.deepseek.section.28c8b91c5d',
              'DeepSeek'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.accounts.pane.deepseek.section.53ce175669',
              'Configure DeepSeek usage tracking for your account.'
            )}
          </p>
        </div>
        <a
          href={DEEPSEEK_CONSOLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.accounts.pane.deepseek.section.47e631f32d',
            'Open console'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          deepSeekApiKeyConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            deepSeekApiKeyConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {deepSeekApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepseek.section.16fb212002',
                  'Stored locally'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepseek.section.c62df1a6cd',
                  'Credentials not set'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.accounts.pane.deepseek.section.e60b2e635a',
              'Stored locally in the Orca encrypted credential store and sent to DeepSeek only to refresh your balance.'
            )}
          </p>
        </div>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.deepseek.section.59d9d40b95',
          'DeepSeek API key'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.deepseek.section.0c4385003d',
          'Paste the API key from your DeepSeek platform account for local balance fetching.'
        )}
        keywords={['deepseek', 'api key', 'balance', 'usage', 'credits']}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="deepseek-api-key">
            {translate(
              'auto.components.settings.accounts.pane.deepseek.section.59d9d40b95',
              'DeepSeek API key'
            )}
          </Label>
          <Badge
            variant={deepSeekApiKeyConfigured ? 'secondary' : 'outline'}
            className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
          >
            {deepSeekApiKeyConfigured ? (
              <Lock className="size-3" />
            ) : (
              <LockOpen className="size-3" />
            )}
            {deepSeekApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepseek.section.f5d5cdde38',
                  'Saved'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepseek.section.d47451b104',
                  'Not saved'
                )}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Input
            id="deepseek-api-key"
            type="password"
            disabled={deepSeekCredentialBusy}
            value={deepSeekApiKeyDraft}
            onChange={(e) => setDeepSeekApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.accounts.pane.deepseek.section.71ec71b74d',
              'Paste your DeepSeek API key'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveDeepSeekApiKey()}
            disabled={deepSeekCredentialBusy || !deepSeekApiKeyDraft.trim()}
            className="h-7 shrink-0 text-xs"
          >
            {deepSeekCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {deepSeekApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepseek.section.64da8edf4b',
                  'Replace'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepseek.section.21f2625976',
                  'Save'
                )}
          </Button>
          {deepSeekApiKeyConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearDeepSeekApiKey()}
              disabled={deepSeekCredentialBusy}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {translate(
                'auto.components.settings.accounts.pane.deepseek.section.bc10d6273f',
                'Forget key'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.deepseek.section.27efc84bc7',
            'Create a key in your DeepSeek platform account and paste it here. The DeepSeek API exposes only the current balance — there is no usage or cost history to show — and the balance may be denominated in CNY or USD depending on the account.'
          )}
        </p>
      </SearchableSetting>
    </section>
  )
}
