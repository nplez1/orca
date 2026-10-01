import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  formatResetCountdown,
  formatResetDuration
} from '../../../../shared/rate-limit-reset-format'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  ClaudeIcon,
  CopilotIcon,
  DeepSeekIcon,
  FireworksIcon,
  GeminiIcon,
  MiniMaxIcon,
  OpenAIIcon,
  OpenCodeGoIcon
} from './icons'
import { creditsItemRows, describeCredits } from './provider-credits-format'
import { describeAllowance } from './provider-allowance-format'
import { translate } from '@/i18n/i18n'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import {
  ProviderRateLimitWindowSection,
  getWindowSections
} from './provider-rate-limit-window-sections'

// Re-exported from its shared home so status-bar callers keep a single import.
export { clampUsedPercent } from '../../../../shared/usage-percentage-display'

export {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

// Re-export so status-bar callers keep a single import path for tooltip pieces.
export {
  barColor,
  getWindowSections,
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT
} from './provider-rate-limit-window-sections'

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) {
    return 'just now'
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) {
    return `${mins}m ago`
  }
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

// Re-export so existing tooltip consumers/tests keep their import path; the
// implementation is shared with mobile in src/shared/rate-limit-reset-format.
export { formatResetCountdown }

export function formatResetCreditExpiry(
  expiresAt: number | null | undefined,
  count: number
): string | null {
  if (!expiresAt) {
    return null
  }
  const duration = formatResetDuration(expiresAt - Date.now())
  if (duration === 'now') {
    return count > 1
      ? translate('auto.components.status.bar.tooltip.7ec6e030a0', 'Next expires now')
      : translate('auto.components.status.bar.tooltip.d1e442a9e5', 'Expires now')
  }
  return count > 1
    ? translate('auto.components.status.bar.tooltip.6cf9eaed10', 'Next expires in {{value0}}', {
        value0: duration
      })
    : translate('auto.components.status.bar.tooltip.20ad66aed1', 'Expires in {{value0}}', {
        value0: duration
      })
}

// ---------------------------------------------------------------------------
// Shared icon component
// ---------------------------------------------------------------------------

export function ProviderIcon({ provider }: { provider: string }): React.JSX.Element {
  if (provider === 'codex') {
    return <OpenAIIcon size={13} />
  }
  if (provider === 'gemini') {
    return <GeminiIcon size={13} />
  }
  if (provider === 'opencode-go') {
    return <OpenCodeGoIcon size={13} />
  }
  if (provider === 'kimi') {
    return <AgentIcon agent="kimi" size={13} />
  }
  if (provider === 'antigravity') {
    return <AgentIcon agent="antigravity" size={13} />
  }
  if (provider === 'minimax') {
    return <MiniMaxIcon size={13} />
  }
  if (provider === 'grok') {
    return <AgentIcon agent="grok" size={13} />
  }
  if (provider === 'zcode') {
    return <AgentIcon agent="zcode" size={13} />
  }
  if (provider === 'cursor') {
    return <AgentIcon agent="cursor" size={13} />
  }
  if (provider === 'deepseek') {
    return <DeepSeekIcon size={13} />
  }
  if (provider === 'fireworks') {
    return <FireworksIcon size={13} />
  }
  if (provider === 'copilot') {
    return <CopilotIcon size={13} />
  }
  return <ClaudeIcon size={13} />
}

function ErrorMessage({
  message,
  label,
  stale = false,
  inverted = false
}: {
  message: string
  label?: string
  /** When true, prior data is still visible — show a softer "refresh failed" label. */
  stale?: boolean
  inverted?: boolean
}): React.JSX.Element {
  const labelClass = inverted ? 'text-background/80' : 'text-foreground/85'
  const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground'
  const genericRefreshLabel = translate(
    'auto.components.status.bar.tooltip.e740f92596',
    'Refresh failed'
  )
  const staleRefreshLabel = translate(
    'auto.components.status.bar.tooltip.a9a318b7a3',
    'Refresh failed — showing cached data'
  )
  const resolvedLabel =
    stale && (!label || label === genericRefreshLabel)
      ? staleRefreshLabel
      : (label ?? genericRefreshLabel)

  return (
    <div className="space-y-0.5">
      <div className={`text-[11px] font-medium ${labelClass}`}>{resolvedLabel}</div>
      <div className={detailClass}>{message}</div>
    </div>
  )
}

export function ProviderPanel({
  p,
  inverted = false,
  className,
  showResetCredits = true,
  usagePercentageDisplay = 'used'
}: {
  p: ProviderRateLimits | null
  inverted?: boolean
  className?: string
  showResetCredits?: boolean
  usagePercentageDisplay?: UsagePercentageDisplay
}): React.JSX.Element {
  const windowSections = p ? getWindowSections(p) : []
  const now = useResetCountdownClock(windowSections.map((section) => section.window?.resetsAt))
  const textClass = inverted ? 'text-background' : 'text-foreground'
  const mutedClass = inverted ? 'text-background/60' : 'text-muted-foreground'
  const faintClass = inverted ? 'text-background/50' : 'text-muted-foreground/80'
  // Why: keep the exhausted-balance warning legible on an inverted surface, like the error path above.
  const warningClass = inverted ? 'text-background/80' : 'text-destructive'
  const dividerClass = inverted ? 'border-background/15' : 'border-border/70'
  const emptyBarClass = inverted ? 'bg-background/20' : 'bg-muted'

  if (!p) {
    return (
      <span className={`text-xs ${mutedClass}`}>
        {translate('auto.components.status.bar.tooltip.6d6df77f41', 'No data available')}
      </span>
    )
  }

  const name = getProviderDisplayName(p.provider)

  if (p.status === 'unavailable') {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={mutedClass}>
          {p.error ?? translate('auto.components.status.bar.tooltip.1292d4f2ee', 'Unavailable')}
        </div>
      </div>
    )
  }

  // Why: an allowance-only plan has no window and no credits, and still has a
  // cached readout worth showing instead of the empty-error branch.
  if (
    p.status === 'error' &&
    !p.session &&
    !p.weekly &&
    !p.fableWeekly &&
    !p.monthly &&
    !p.credits &&
    !p.allowance
  ) {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="mt-2">
          <ErrorMessage
            label={getProviderUsageStatusLabel(p)}
            message={getProviderUsageErrorMessage(p)}
            inverted={inverted}
          />
        </div>
      </div>
    )
  }

  const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated'
  const resetCreditCount =
    showResetCredits && p.provider === 'codex'
      ? (p.rateLimitResetCredits?.availableCount ?? null)
      : null
  const resetCreditExpiry =
    resetCreditCount != null
      ? formatResetCreditExpiry(p.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  const credits = p.credits ?? null
  const creditItems = credits ? creditsItemRows(credits) : []
  const hasWindowRows = windowSections.some((section) => section.window)
  // Why: an allowance-only plan's readout must survive a refresh failure the way
  // a credits-only one does, or a stale error drops it instead of marking it stale.
  const hasCachedData = !!(
    p.session ||
    p.weekly ||
    p.fableWeekly ||
    p.monthly ||
    credits ||
    p.allowance
  )

  return (
    <div className={`${className ?? 'w-full'} space-y-3 text-xs`}>
      <div>
        <div className={`flex items-center gap-1.5 text-[13px] font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={faintClass}>{updatedAgo}</div>
        {resetCreditCount !== null && resetCreditCount !== undefined ? (
          <div className={mutedClass}>
            {resetCreditCount === 1
              ? translate(
                  'auto.components.status.bar.tooltip.45198c7d95',
                  '1 rate-limit reset available'
                )
              : translate(
                  'auto.components.status.bar.tooltip.bce421cba3',
                  '{{value0}} rate-limit resets available',
                  { value0: resetCreditCount }
                )}
          </div>
        ) : null}
        {resetCreditExpiry ? <div className={faintClass}>{resetCreditExpiry}</div> : null}
        {credits ? (
          <div data-provider-credits className={`tabular-nums ${mutedClass}`}>
            {describeCredits(credits)}
          </div>
        ) : null}
        {creditItems.length > 0 ? (
          <div className={`flex flex-wrap gap-x-2.5 ${faintClass}`}>
            {creditItems.map((row) => (
              <span key={row.key} className="tabular-nums">
                {row.label} {row.amount}
              </span>
            ))}
          </div>
        ) : null}
        {p.allowance ? (
          <div data-provider-allowance className={`tabular-nums ${mutedClass}`}>
            {describeAllowance(p.allowance)}
          </div>
        ) : null}
        {credits?.available === false ? (
          // Why: an exhausted-but-configured balance must stay visible and say
          // why calls fail; status stays 'ok' by design for exactly this case.
          <div className={`text-[11px] font-medium ${warningClass}`}>
            {translate(
              'auto.components.status.bar.tooltip.df60b41813',
              'Balance cannot fund further calls'
            )}
          </div>
        ) : null}
      </div>

      {hasWindowRows || p.error ? <div className={`border-t ${dividerClass}`} /> : null}

      {windowSections.map((s) => (
        <ProviderRateLimitWindowSection
          key={s.label}
          window={s.window}
          label={s.label}
          textClass={textClass}
          mutedClass={mutedClass}
          emptyBarClass={emptyBarClass}
          usagePercentageDisplay={usagePercentageDisplay}
          now={now}
        />
      ))}

      {p.error ? (
        <ErrorMessage message={p.error} stale={hasCachedData} inverted={inverted} />
      ) : null}
    </div>
  )
}
