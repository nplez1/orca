import { Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { translate } from '@/i18n/i18n'

export function renderDeepInfraAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    deepInfraApiKeyDraft,
    setDeepInfraApiKeyDraft,
    deepInfraApiKeyConfigured,
    deepInfraCredentialBusy,
    saveDeepInfraApiKey,
    clearDeepInfraApiKey
  } = model
  return (
    <>
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          deepInfraApiKeyConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            deepInfraApiKeyConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {deepInfraApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.0a66e44378',
                  'Stored locally'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.55811fed23',
                  'Credentials not set'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.accounts.pane.deepinfra.section.6ac1f27caa',
              'Stored locally in the Orca encrypted credential store and sent to DeepInfra only to refresh your balance.'
            )}
          </p>
        </div>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.accounts.pane.deepinfra.section.9238a0ca54',
          'DeepInfra API key'
        )}
        description={translate(
          'auto.components.settings.accounts.pane.deepinfra.section.76987731d3',
          'Paste the API key from your DeepInfra account for local balance fetching.'
        )}
        keywords={['deepinfra', 'api key', 'balance', 'usage', 'credits']}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="deepinfra-api-key">
            {translate(
              'auto.components.settings.accounts.pane.deepinfra.section.9238a0ca54',
              'DeepInfra API key'
            )}
          </Label>
          <Badge variant={deepInfraApiKeyConfigured ? 'secondary' : 'outline'}>
            {deepInfraApiKeyConfigured ? (
              <Lock className="size-3" />
            ) : (
              <LockOpen className="size-3" />
            )}
            {deepInfraApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.5c5b925371',
                  'Saved'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.130bde22a6',
                  'Not saved'
                )}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Input
            id="deepinfra-api-key"
            type="password"
            disabled={deepInfraCredentialBusy}
            value={deepInfraApiKeyDraft}
            onChange={(e) => setDeepInfraApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.accounts.pane.deepinfra.section.e5d69f6d65',
              'Paste your DeepInfra API key'
            )}
            spellCheck={false}
            className="flex-1"
          />
          <Button
            size="xs"
            onClick={() => void saveDeepInfraApiKey()}
            disabled={deepInfraCredentialBusy || !deepInfraApiKeyDraft.trim()}
            className="h-7 shrink-0"
          >
            {deepInfraCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {deepInfraApiKeyConfigured
              ? translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.e93b4fbf52',
                  'Replace'
                )
              : translate(
                  'auto.components.settings.accounts.pane.deepinfra.section.be46f681d0',
                  'Save'
                )}
          </Button>
          {deepInfraApiKeyConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearDeepInfraApiKey()}
              disabled={deepInfraCredentialBusy}
              className="h-7 shrink-0"
            >
              {translate(
                'auto.components.settings.accounts.pane.deepinfra.section.03dc995e2f',
                'Forget key'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.pane.deepinfra.section.c0c86aa3d1',
            'Create a key in your DeepInfra account and paste it here. Orca reads your remaining credit balance, in US dollars, from the same billing summary the DeepInfra dashboard shows.'
          )}
        </p>
      </SearchableSetting>
    </>
  )
}
