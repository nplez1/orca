import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { translate } from '@/i18n/i18n'
import { formatUsagePercentageLabel } from './usage-percentage-label'

// ---------------------------------------------------------------------------
// Window section derivation
// ---------------------------------------------------------------------------

export function getWindowSections(
  p: ProviderRateLimits
): { label: string; window: RateLimitWindow | null }[] {
  if (p.buckets?.length) {
    const bucketSections = p.buckets.map((b) => ({ label: b.name, window: b as RateLimitWindow }))
    return [
      ...bucketSections,
      // Why: Cursor reports the plan total in `monthly` and its pools as buckets,
      // so dropping it here would hide the number closest to the user's cap.
      ...(p.monthly
        ? [
            {
              label:
                p.provider === 'cursor'
                  ? translate('auto.components.status.bar.tooltip.cursor.plan', 'Plan')
                  : translate('auto.components.status.bar.tooltip.7f7f208060', 'Monthly'),
              window: p.monthly
            }
          ]
        : []),
      {
        label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
        window: p.weekly
      }
    ]
  }
  const sections: { label: string; window: RateLimitWindow | null }[] = [
    {
      label: translate('auto.components.status.bar.tooltip.94038ad2fa', 'Session'),
      window: p.session
    },
    {
      label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
      window: p.weekly
    }
  ]
  if (p.fableWeekly !== undefined && p.fableWeekly !== null) {
    sections.push({
      label: translate('auto.components.status.bar.tooltip.a79c64f87e', 'Fable'),
      window: p.fableWeekly
    })
  }
  if (p.monthly !== undefined && p.monthly !== null) {
    sections.push({
      label:
        p.provider === 'zcode'
          ? translate('auto.components.status.bar.tooltip.zcode.mcp', 'MCP')
          : translate('auto.components.status.bar.tooltip.7f7f208060', 'Monthly'),
      window: p.monthly
    })
  }
  return sections
}

// ---------------------------------------------------------------------------
// Tooltip — progress bar section for a single window
// ---------------------------------------------------------------------------

// Why: the base tooltip component uses `bg-foreground text-background` which
// inverts the color scheme (light bg in dark mode). These rich tooltips use
// `text-background` for primary text and `text-background/50` for secondary
// to stay readable inside the inverted tooltip container.

// Why: urgency color tracks % used even when fill represents % remaining;
// low usage stays neutral so persistent chrome stays quiet.
export const USAGE_WARNING_PERCENT = 60
export const USAGE_URGENT_PERCENT = 80

export function barColor(usedPct: number): string {
  if (usedPct < USAGE_WARNING_PERCENT) {
    return 'bg-muted-foreground/40'
  }
  if (usedPct < USAGE_URGENT_PERCENT) {
    return 'bg-yellow-500'
  }
  return 'bg-red-500'
}

export function ProviderRateLimitWindowSection({
  window,
  label,
  textClass,
  mutedClass,
  emptyBarClass,
  usagePercentageDisplay,
  now
}: {
  window: RateLimitWindow | null
  label: string
  textClass: string
  mutedClass: string
  emptyBarClass: string
  usagePercentageDisplay: UsagePercentageDisplay
  now: number
}): React.JSX.Element | null {
  if (!window) {
    return null
  }
  const usedPct = clampUsedPercent(window.usedPercent)
  const displayedPct = getDisplayedUsagePercentage(usedPct, usagePercentageDisplay)
  const resetLabel = window.resetsAt ? formatResetCountdown(window.resetsAt - now) : null

  return (
    <div className="space-y-1">
      <div className={`font-medium ${textClass}`}>{label}</div>
      <div className={`h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`}>
        {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
        <div
          className={`h-full rounded-full ${barColor(usedPct)} transition-all duration-300`}
          style={{ width: `${displayedPct}%` }}
        />
      </div>
      <div className={`flex justify-between ${mutedClass}`}>
        <span>{formatUsagePercentageLabel(usedPct, usagePercentageDisplay)}</span>
        {resetLabel && <span>{resetLabel}</span>}
      </div>
    </div>
  )
}
