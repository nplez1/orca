import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import {
  FORK_USAGE_PROVIDER_IDS,
  USAGE_PROVIDER_MANIFEST
} from '../../../../shared/usage-providers/usage-provider-manifest'
import { usageProviderConfiguredFlagDefaults } from '../../../../shared/usage-providers/usage-provider-readouts'
import {
  getVisibleUsageProvider,
  isUsageEmptyState,
  type UsageProviderSettings
} from './status-bar-provider-visibility'
import { isOwnerNotSetUpPlaceholder } from './owner-usage-rate-limits'

/** The controller values a fork provider can change. */
export type ForkStatusBarUsage = {
  anyFetching: boolean
  anyVisible: boolean
  hasVisibleUsageMeters: boolean
  isEmptyUsageState: boolean
  rosterProviders: ProviderRateLimits[]
  showEmptyUsageCta: boolean
}

export type ForkStatusBarUsageInputs = {
  rateLimits: RateLimitState
  /** Upstream's owner-scoped settings object, so the fork inherits its remote-owner handling. */
  settings: Partial<UsageProviderSettings> | null
  statusBarItems: StatusBarItem[]
}

/**
 * The status bar controller's result with the fork's own providers folded in.
 *
 * Why a merge instead of the fork projecting every provider itself: the controller then runs
 * upstream's per-provider body verbatim, so a provider upstream adds arrives as a clean hunk rather
 * than a conflict against a fork copy of that body. A copy also goes stale silently — two upstream
 * fixes (the `!remoteOwned` Antigravity gate, ZCode's saved plan key) had to be ported into the
 * fork's own copy by hand after a merge dropped them.
 *
 * The merge is one-directional, so a value the fork does not understand survives a sync: it only
 * ever widens `anyFetching`, `hasVisibleUsageMeters` and `anyVisible`, and only ever narrows
 * `isEmptyUsageState`.
 *
 * Every fork provider is read off the manifest rather than named here, so a fifth one cannot reach
 * the empty state without also reaching the roster.
 */
export function withForkStatusBarUsage<T extends ForkStatusBarUsage>(
  controller: T,
  inputs: ForkStatusBarUsageInputs
): T {
  // Why: these keys are not in GlobalSettings, so main publishes their presence once per poll.
  const settings = { ...inputs.settings, ...usageProviderConfiguredFlagDefaults(inputs.rateLimits) }
  const snapshots = FORK_USAGE_PROVIDER_IDS.map(
    (providerId) => inputs.rateLimits[USAGE_PROVIDER_MANIFEST[providerId].stateKey]
  )
  const forkProviders = FORK_USAGE_PROVIDER_IDS.map((providerId, index) => {
    const provider = getVisibleUsageProvider(providerId, snapshots[index], settings)
    // Why no PATH gate: every fork provider is an API key or a token, so no installed CLI decides it.
    return provider !== null && inputs.statusBarItems.includes(providerId) ? provider : null
  }).filter((provider): provider is ProviderRateLimits => provider !== null)
  const hasVisibleUsageMeters = controller.hasVisibleUsageMeters || forkProviders.length > 0
  const isEmptyUsageState =
    controller.isEmptyUsageState && isUsageEmptyState(inputs.rateLimits, settings)
  const anyFetching =
    controller.anyFetching || snapshots.some((provider) => provider?.status === 'fetching')

  return {
    ...controller,
    anyFetching,
    anyVisible: hasVisibleUsageMeters || controller.anyVisible,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    // Why concat then sort: upstream's chips keep their order, and the bar collapses chips from the
    // end, so a placeholder still gives way before a live meter.
    rosterProviders: [...controller.rosterProviders, ...forkProviders].sort(
      (a, b) => Number(isOwnerNotSetUpPlaceholder(a)) - Number(isOwnerNotSetUpPlaceholder(b))
    ),
    // Why: the fork only ever narrows the empty state, so it can clear a callout upstream decided to
    // show but never invent one.
    showEmptyUsageCta: isEmptyUsageState && controller.showEmptyUsageCta
  }
}
