import type { ReactNode } from 'react'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'

/**
 * The one control that turns a usage provider off for good: while off, Orca neither
 * polls the provider nor reads its sign-in from software installed on this computer
 * (Cursor, Codex, `gh`, Grok/Gemini/OpenCode auth files, the macOS Claude Keychain).
 */
export function ProviderUsageEnableSwitch({
  providerId,
  providerLabel,
  enabled,
  onEnabledChange
}: {
  providerId: DisableableUsageProviderId
  providerLabel: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}): React.JSX.Element {
  const label = translate(
    'auto.components.settings.ProviderUsageEnableSwitch.8e832829e7',
    'Let Orca query {{value0}}',
    { value0: providerLabel }
  )
  const description = translate(
    'auto.components.settings.ProviderUsageEnableSwitch.e3340ac4e1',
    'When off, Orca never asks {{value0}} for usage and never reads its sign-in from software installed on this computer.',
    { value0: providerLabel }
  )
  const switchId = `usage-provider-enabled-${providerId}`
  return (
    <SearchableSetting
      title={label}
      description={description}
      keywords={[
        'provider',
        'usage',
        'enable',
        'disable',
        'privacy',
        'query',
        'sign-in',
        providerId,
        providerLabel.toLocaleLowerCase()
      ]}
      // Why: the section's own search entry already decided visibility; the master
      // switch is part of that section's chrome, not a separate search result.
      forceVisible
      className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
    >
      <div className="space-y-0.5">
        <Label htmlFor={switchId}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={switchId}
        aria-label={label}
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />
    </SearchableSetting>
  )
}

/** Shown in place of a provider's controls while it is switched off. */
export function ProviderUsageDisabledNotice({
  providerLabel
}: {
  providerLabel: string
}): React.JSX.Element {
  return (
    <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      {translate(
        'auto.components.settings.ProviderUsageEnableSwitch.e9b8e0fc2e',
        '{{value0}} is off. Orca will not query it or read its sign-in from software installed on this computer.',
        { value0: providerLabel }
      )}
    </p>
  )
}

/**
 * Wraps one provider section in the pane: the master switch on top, then either the
 * section's own controls or the off notice. The section is not mounted while off, so
 * its mount-time status reads never run.
 */
export function UsageProviderSectionGate({
  providerId,
  providerLabel,
  disabled,
  onEnabledChange,
  children
}: {
  providerId: DisableableUsageProviderId
  providerLabel: string
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <ProviderUsageEnableSwitch
        providerId={providerId}
        providerLabel={providerLabel}
        enabled={!disabled}
        onEnabledChange={onEnabledChange}
      />
      {disabled ? <ProviderUsageDisabledNotice providerLabel={providerLabel} /> : children}
    </div>
  )
}
