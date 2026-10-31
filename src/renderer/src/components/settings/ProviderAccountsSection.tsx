import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { openAppHttpLinkFromAnchor } from '@/lib/app-http-link-open'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Switch } from '../ui/switch'

export type ProviderAccountsIcon = (props: { size?: number }) => React.JSX.Element

/** The header's right-hand shortcut (console, dashboard or docs) for one provider. */
export function ProviderHeaderLink({
  href,
  label
}: {
  href: string
  label: string
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openAppHttpLinkFromAnchor}
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  )
}

/**
 * The header every provider section in AI Provider Accounts shares. Owning the
 * title, the icon and the usage switch here is what makes the switch part of the
 * render path rather than something each new provider has to remember to add.
 *
 * The switch leads the row so it is read before the provider name, and the
 * provider's own controls are not mounted while it is off — so no pane-triggered
 * credential read can run for a provider the user switched off.
 */
export function ProviderAccountsSection({
  providerId,
  title,
  description,
  Icon,
  headerAction,
  enabled,
  onEnabledChange,
  children
}: {
  providerId: DisableableUsageProviderId
  /** The provider's own display name, also used as the off notice's subject. */
  title: string
  description: string
  Icon: ProviderAccountsIcon
  headerAction?: ReactNode
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  const switchId = `usage-provider-enabled-${providerId}`
  const switchLabel = translate(
    'auto.components.settings.ProviderUsageEnableSwitch.8e832829e7',
    'Let Orca query {{value0}}',
    { value0: title }
  )
  // Why: the consequence of switching a provider off no longer fits under a
  // per-provider paragraph, so it stays one hover away on the control that causes it.
  const switchHint = translate(
    'auto.components.settings.ProviderUsageEnableSwitch.e3340ac4e1',
    'When off, Orca never asks {{value0}} for usage and never reads its sign-in from software installed on this computer.',
    { value0: title }
  )
  return (
    <section id={`accounts-${providerId}`} className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Switch
            id={switchId}
            aria-label={switchLabel}
            title={switchHint}
            checked={enabled}
            onCheckedChange={onEnabledChange}
            className="mt-0.5"
          />
          <div className="min-w-0 space-y-1">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Icon size={16} />
              {title}
              {enabled ? null : (
                <Badge variant="hostContext">
                  {translate('auto.components.settings.ProviderAccountsSection.off', 'Off')}
                </Badge>
              )}
            </h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {headerAction}
      </div>
      {enabled ? (
        children
      ) : (
        <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ProviderUsageEnableSwitch.e9b8e0fc2e',
            '{{value0}} is off. Orca will not query it or read its sign-in from software installed on this computer.',
            { value0: title }
          )}
        </p>
      )}
    </section>
  )
}
