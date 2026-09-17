import { ExternalLink, Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FireworksIcon } from '../status-bar/icons'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { translate } from '@/i18n/i18n'

const FIREWORKS_CONSOLE_URL = 'https://app.fireworks.ai/settings/users/api-keys'

export function renderFireworksAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    fireworksApiKeyDraft,
    setFireworksApiKeyDraft,
    fireworksAccountIdDraft,
    setFireworksAccountIdDraft,
    fireworksApiKeyConfigured,
    fireworksCredentialBusy,
    saveFireworksCredentials,
    clearFireworksCredentials
  } = model
  return (
    <section key="fireworks" id="accounts-fireworks" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FireworksIcon size={16} />
            {translate(
              'auto.components.settings.accounts.pane.fireworks.section.51bcc16ae3',
              'Fireworks.ai'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.accounts.pane.fireworks.section.5f31aaba69',
              'Configure Fireworks.ai usage tracking for your account.'
            )}
          </p>
        </div>
        <a
          href={FIREWORKS_CONSOLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.accounts.pane.fireworks.section.d8c675f9f0',
            'Open console'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          fireworksApiKeyConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            fireworksApiKeyConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {fireworksApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.fireworks.section.fb3c265f9d',
                  'Stored locally'
                )
              : translate(
                  'auto.components.settings.accounts.pane.fireworks.section.084f43d064',
                  'Credentials not set'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.accounts.pane.fireworks.section.56669b1597',
              'Stored locally in the Orca encrypted credential store and sent to Fireworks.ai only to refresh your rated spend.'
            )}
          </p>
        </div>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.fireworks.section.1fd991909e',
          'Fireworks API key'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.fireworks.section.5e8948033a',
          'Paste the API key from your Fireworks.ai account for local spend fetching.'
        )}
        keywords={['fireworks', 'api key', 'spend', 'usage', 'billing']}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="fireworks-api-key">
            {translate(
              'auto.components.settings.accounts.pane.fireworks.section.1fd991909e',
              'Fireworks API key'
            )}
          </Label>
          <Badge
            variant={fireworksApiKeyConfigured ? 'secondary' : 'outline'}
            className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
          >
            {fireworksApiKeyConfigured ? (
              <Lock className="size-3" />
            ) : (
              <LockOpen className="size-3" />
            )}
            {fireworksApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.fireworks.section.d2eb5b59e0',
                  'Saved'
                )
              : translate(
                  'auto.components.settings.accounts.pane.fireworks.section.077467c5d6',
                  'Not saved'
                )}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Input
            id="fireworks-api-key"
            type="password"
            disabled={fireworksCredentialBusy}
            value={fireworksApiKeyDraft}
            onChange={(e) => setFireworksApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.accounts.pane.fireworks.section.1b29aa7268',
              'Paste your Fireworks API key'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveFireworksCredentials()}
            disabled={
              fireworksCredentialBusy ||
              (!fireworksApiKeyDraft.trim() && !fireworksApiKeyConfigured)
            }
            className="h-7 shrink-0"
          >
            {fireworksCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {fireworksApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.fireworks.section.2ccc2fea25',
                  'Replace'
                )
              : translate(
                  'auto.components.settings.accounts.pane.fireworks.section.b98b4449d5',
                  'Save'
                )}
          </Button>
          {fireworksApiKeyConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearFireworksCredentials()}
              disabled={fireworksCredentialBusy}
              className="h-7 shrink-0 text-muted-foreground hover:text-foreground"
            >
              {translate(
                'auto.components.settings.accounts.pane.fireworks.section.545da4ee6c',
                'Forget key'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.fireworks.section.fd8437b974',
            'Create a key in your Fireworks.ai account and paste it here. Orca refreshes rated spend for the current billing period, in US dollars.'
          )}
        </p>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.fireworks.section.2cea3b33f9',
          'Fireworks account ID'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.fireworks.section.c1c89f3dac',
          'Optional account ID override for keys that can see more than one Fireworks.ai account.'
        )}
        keywords={['fireworks', 'account id', 'override', 'spend', 'usage']}
        className="space-y-2"
      >
        <Label htmlFor="fireworks-account-id">
          {translate(
            'auto.components.settings.accounts.pane.fireworks.section.797cd4833e',
            'Account ID (optional)'
          )}
        </Label>
        <Input
          id="fireworks-account-id"
          type="text"
          disabled={fireworksCredentialBusy}
          value={fireworksAccountIdDraft}
          onChange={(e) => setFireworksAccountIdDraft(e.target.value)}
          placeholder={translate(
            'auto.components.settings.accounts.pane.fireworks.section.c9bd728853',
            'Auto-detected from the API key'
          )}
          spellCheck={false}
          className="text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.fireworks.section.d74a913846',
            'Orca discovers the account ID from your API key. Set an override only when the key can see multiple accounts; leave it blank to keep auto-detection. Saving with the API key field blank keeps your stored key, and Forget key clears the account ID as well.'
          )}
        </p>
      </SearchableSetting>
    </section>
  )
}
