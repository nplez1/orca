import { RateLimitServiceFetchTargets } from './service-fetch-targets'
import { withoutResetWindows } from './service-result-policy'
import {
  LIVE_CLAUDE_INGEST_DEDUPE_MS,
  MIN_REFETCH_MS,
  normalizeClaudeConfigDir,
  type ActiveRateLimitProvider
} from './service-types'
import type { ForkUsageProviderId } from '../../../shared/usage-providers/usage-provider-manifest'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import type { ClaudeStatusLineRateLimits } from '../../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'
import type { NormalizedClaudeAccountSelectionTarget } from '../../claude-accounts/selection/runtime-selection'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  isSameClaudeUsageReset,
  isSameClaudeUsageWindow,
  isStaleClaudeUsageWindow,
  mapClaudeUsageWindow
} from '../providers/claude/claude-usage-window'
import { claudeOAuthUsageDisabledResult } from '../providers/claude/claude-usage-result'
import {
  ClaudeLiveUsageSessionReports,
  type ClaudeLiveUsageWindowKind
} from '../providers/claude/claude-live-usage-session-reports'
import { readUserClaudeConfigDir } from '../../claude-accounts/profiles/claude-profile-paths'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { retryAfterBlocksProviderLane } from '../fork/claude-active-usage-probe'

export abstract class RateLimitServiceFetchPolicy extends RateLimitServiceFetchTargets {
  private readonly claudeSessionReports = new ClaudeLiveUsageSessionReports()

  protected isClaudeOAuthUsageEnabled(): boolean {
    return this.claudeOAuthUsageEnabledResolver?.() ?? true
  }

  protected claudeUsageFetchSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.claudeUsageAbortController.signal])
  }

  protected claudeUsageWithoutOAuth(): ProviderRateLimits {
    const live = this.liveClaudeUsage ? withoutResetWindows(this.liveClaudeUsage, Date.now()) : null
    return live?.session || live?.weekly ? live : claudeOAuthUsageDisabledResult()
  }

  protected getMiniMaxCredentialError(message: string): ProviderRateLimits {
    return {
      provider: 'minimax',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    }
  }

  protected getZcodePlanCredentialError(message: string): ProviderRateLimits {
    return {
      provider: 'zcode',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    }
  }

  // Why: an unreadable API-key file must surface as that provider's own error rather than aborting every other provider's refresh.
  protected getApiKeyCredentialError(
    provider: ForkUsageProviderId,
    message: string
  ): ProviderRateLimits {
    return {
      provider,
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    }
  }

  protected claudeStateAtCycleStart(limits: ProviderRateLimits | null): ProviderRateLimits {
    return this.isClaudeOAuthUsageEnabled()
      ? this.withFetchingStatus(limits, 'claude')
      : this.claudeUsageWithoutOAuth()
  }

  // Why: hitting a usage endpoint before its Retry-After expires burns the budget for nothing and keeps the 429 window alive.
  // A live post flips the snapshot back to ok, but the endpoint's Retry-After is still binding.
  protected isRetryAfterActive(limits: ProviderRateLimits | null): boolean {
    return Boolean(limits?.usageMetadata?.retryAtMs && limits.usageMetadata.retryAtMs > Date.now())
  }

  // A live receipt preserves display, not proof of selected-account freshness.
  protected isLiveClaudeUsageFresh(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'ok' &&
      limits.usageMetadata?.source === 'live-session' &&
      Date.now() - limits.updatedAt < MIN_REFETCH_MS
    )
  }

  // Claude's Retry-After binds automated checks; user refreshes may pass.
  protected shouldSkipAutomatedFetch(
    provider: ActiveRateLimitProvider,
    limits: ProviderRateLimits | null
  ): boolean {
    return (
      provider === 'claude' &&
      this.isRetryAfterActive(limits) &&
      !this.canRefreshThroughRetryAfter(provider)
    )
  }

  // fork-comment-ok: the CLI probe answers without the endpoint, so its Retry-After cannot stop the lane.
  protected canRefreshThroughRetryAfter(provider: ActiveRateLimitProvider): boolean {
    return !retryAfterBlocksProviderLane(provider, this.shouldAllowClaudeUsagePanelSupplement())
  }

  protected resolveClaudeFetchApply(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    if (!this.isClaudeOAuthUsageEnabled()) {
      return this.claudeUsageWithoutOAuth()
    }
    this.lastClaudeCheckCompletedAt = fresh.updatedAt
    // Failed OAuth must preserve newer live display while forwarding Retry-After to the poll gate.
    const current = this.state.claude
    if (fresh.status !== 'ok' && current && this.isLiveClaudeUsageFresh(current)) {
      const retryAtMs = fresh.usageMetadata?.retryAtMs
      return retryAtMs
        ? { ...current, usageMetadata: { ...current.usageMetadata, retryAtMs } }
        : current
    }
    return this.applyStalePolicy(fresh, previous)
  }

  protected rememberClaudeAuthSnapshot(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined,
    claudeGeneration: number,
    claudeTarget: NormalizedClaudeAccountSelectionTarget
  ): void {
    // A switch during resolver await invalidates attribution; never restore the outgoing configDir.
    if (
      claudeGeneration !== this.claudeFetchGeneration ||
      !this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    ) {
      return
    }
    const snapshot = {
      // System Default uses the user config folder without injecting a managed one.
      configDir: normalizeClaudeConfigDir(
        authPreparation?.envPatch.CLAUDE_CONFIG_DIR ??
          getClaudeProfileRouter()?.userConfigDir() ??
          readUserClaudeConfigDir(process.env)
      ),
      home: authPreparation?.configDir,
      provenance: authPreparation?.provenance ?? 'system'
    }
    if (
      snapshot.configDir !== this.lastClaudeAuthSnapshot?.configDir ||
      snapshot.provenance !== this.lastClaudeAuthSnapshot?.provenance
    ) {
      this.liveClaudeUsage = null
    }
    this.lastClaudeAuthSnapshot = snapshot
  }

  ingestLiveClaudeRateLimits(event: ClaudeStatusLineRateLimits): void {
    // Wait for a selected-account snapshot rather than guessing live-post attribution.
    const snapshot = this.lastClaudeAuthSnapshot
    if (!snapshot) {
      console.debug('[rate-limits] dropped live Claude usage: no auth snapshot yet', {
        eventConfigDir: event.configDir
      })
      return
    }
    // Different accounts/runtimes report their own quota; never merge them into this bar.
    if (normalizeClaudeConfigDir(event.configDir) !== snapshot.configDir) {
      console.debug('[rate-limits] dropped live Claude usage: configDir mismatch', {
        eventConfigDir: event.configDir,
        snapshotConfigDir: snapshot.configDir
      })
      return
    }
    const previous = this.state.claude
    const now = Date.now()
    const configDir = snapshot.configDir
    const sessionId = event.sessionId ?? null
    const sessionReports = this.claudeSessionReports
    // An idle session's older snapshot must not roll back newer account usage.
    const keepIfNewer = (
      kind: ClaudeLiveUsageWindowKind,
      incoming: RateLimitWindow | null,
      current: RateLimitWindow | null | undefined
    ): RateLimitWindow | null => {
      if (!incoming) {
        return null
      }
      const reset = sessionReports.recordReset(sessionId, configDir, kind, incoming)
      if (
        current &&
        !sessionReports.hasChanged(sessionId, configDir, kind, incoming) &&
        !isSameClaudeUsageWindow(current, incoming) &&
        sessionReports.isResetWindow(configDir, kind, incoming, now)
      ) {
        return null
      }
      if (
        isStaleClaudeUsageWindow(current, incoming, now) &&
        !(reset && isSameClaudeUsageReset(current?.resetsAt ?? null, incoming.resetsAt))
      ) {
        return null
      }
      return isSameClaudeUsageWindow(current ?? null, incoming) ? (current ?? null) : incoming
    }
    const incomingSession = mapClaudeUsageWindow(event.fiveHour ?? undefined, 300)
    const incomingWeekly = mapClaudeUsageWindow(event.sevenDay ?? undefined, 10080)
    const freshSession = keepIfNewer('session', incomingSession, previous?.session)
    const freshWeekly = keepIfNewer('weekly', incomingWeekly, previous?.weekly)
    if (sessionId !== null) {
      sessionReports.remember(sessionId, configDir, {
        session: incomingSession,
        weekly: incomingWeekly
      })
    }
    if (!freshSession && !freshWeekly) {
      return
    }
    // Kept snapshots can outlive a reset; never relabel a past-reset window as live.
    const inherited = previous ? withoutResetWindows(previous, now) : null
    // Statusline posts carry no plan; keep the one read for this same login, with its account.
    const sameLogin = inherited?.usageMetadata?.authProvenance === snapshot.provenance
    // Partial statusline payloads leave unreported windows unchanged.
    const session = freshSession ?? inherited?.session ?? null
    const weekly = freshWeekly ?? inherited?.weekly ?? null
    // Stale posts that repeat the surviving window must not refresh live-feed age.
    const droppedStale = (incomingSession && !freshSession) || (incomingWeekly && !freshWeekly)
    if (
      droppedStale &&
      isSameClaudeUsageWindow(previous?.session ?? null, session) &&
      isSameClaudeUsageWindow(previous?.weekly ?? null, weekly)
    ) {
      return
    }
    const priorLive = this.liveClaudeUsage ? withoutResetWindows(this.liveClaudeUsage, now) : null
    this.liveClaudeUsage = {
      provider: 'claude',
      session: freshSession ?? priorLive?.session ?? null,
      weekly: freshWeekly ?? priorLive?.weekly ?? null,
      updatedAt: now,
      error: null,
      status: 'ok',
      usageMetadata: {
        source: 'live-session',
        lastSuccessfulSource: 'live-session',
        authProvenance: snapshot.provenance
      }
    }
    this.rememberUsageReadingAccount(
      'claude',
      this.claudeFetchTarget,
      snapshot.home,
      snapshot.provenance
    )
    if (
      previous?.status === 'ok' &&
      previous.usageMetadata?.source === 'live-session' &&
      now - previous.updatedAt < LIVE_CLAUDE_INGEST_DEDUPE_MS &&
      isSameClaudeUsageWindow(previous.session, session) &&
      isSameClaudeUsageWindow(previous.weekly, weekly)
    ) {
      return
    }
    this.activeFailureStreakByProvider.claude = 0
    this.updateState({
      ...this.state,
      claude: {
        provider: 'claude',
        session,
        weekly,
        // Statusline lacks Fable scope and credits; retain the latest OAuth values.
        fableWeekly: inherited?.fableWeekly ?? null,
        extraUsage: inherited?.extraUsage ?? null,
        ...(sameLogin && inherited.planType ? { planType: inherited.planType } : {}),
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        usageMetadata: {
          source: 'live-session',
          lastSuccessfulSource: 'live-session',
          credentialSource: previous?.usageMetadata?.credentialSource,
          retryAtMs: previous?.usageMetadata?.retryAtMs,
          authProvenance: snapshot.provenance,
          ...(sameLogin && inherited.usageMetadata?.readingAccount
            ? { readingAccount: inherited.usageMetadata.readingAccount }
            : {})
        }
      }
    })
  }
}
