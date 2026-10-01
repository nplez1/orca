import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { getVisibleUsageProvider, isUsageEmptyState } from './status-bar-provider-visibility'

export type StatusBarUsageProjectionInputs = {
  rateLimits: RateLimitState
  settings: GlobalSettings | null
  statusBarItems: StatusBarItem[]
  detectedAgentIds: TuiAgent[] | null
  usageEmptyStateDismissed: boolean
}

export type StatusBarUsageProjection = {
  anyFetching: boolean
  hasVisibleUsageMeters: boolean
  isEmptyUsageState: boolean
  rosterProviders: ProviderRateLimits[]
  showEmptyUsageCta: boolean
}

export function getStatusBarUsageProjection({
  rateLimits,
  settings,
  statusBarItems,
  detectedAgentIds,
  usageEmptyStateDismissed
}: StatusBarUsageProjectionInputs): StatusBarUsageProjection {
  const {
    claude,
    codex,
    gemini,
    opencodeGo,
    kimi,
    antigravity,
    minimax,
    grok,
    cursor,
    zcode,
    deepseek,
    fireworks,
    copilot
  } = rateLimits

  // Why: a bar is earned by a live snapshot or durable Settings setup; detection-gating hides per-CLI bars when the agent isn't on PATH.
  // Why: Antigravity has no persisted credential, so a checked status item + detected CLI is the durable "show its slot" signal.
  // Why: Antigravity visibility also requires geminiCliOAuthEnabled because its usage snapshot mirrors the Gemini fetch.
  const antigravityUsageConfigured =
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Why: thread non-GlobalSettings durability flags so bars stay visible across reloads and snapshot refreshes.
  const usageSettings = {
    ...settings,
    antigravityUsageConfigured,
    minimaxCookieConfigured: rateLimits.minimaxCookieConfigured,
    minimaxApiKeyConfigured: rateLimits.minimaxApiKeyConfigured,
    opencodeGoApiKeyConfigured: rateLimits.opencodeGoApiKeyConfigured,
    grokAuthConfigured: rateLimits.grokAuthConfigured,
    cursorAuthConfigured: rateLimits.cursorAuthConfigured,
    deepseekApiKeyConfigured: rateLimits.deepseekApiKeyConfigured,
    fireworksApiKeyConfigured: rateLimits.fireworksApiKeyConfigured,
    copilotTokenConfigured: rateLimits.copilotTokenConfigured
  }
  const visibleClaude = getVisibleUsageProvider('claude', claude, usageSettings)
  const visibleCodex = getVisibleUsageProvider('codex', codex, usageSettings)
  const visibleGemini = getVisibleUsageProvider('gemini', gemini, usageSettings)
  const visibleKimi = getVisibleUsageProvider('kimi', kimi, usageSettings)
  const visibleAntigravity = getVisibleUsageProvider('antigravity', antigravity, usageSettings)
  const visibleMiniMax = getVisibleUsageProvider('minimax', minimax, usageSettings)
  const visibleGrok = getVisibleUsageProvider('grok', grok, usageSettings)
  const visibleCursor = getVisibleUsageProvider('cursor', cursor, usageSettings)
  const visibleZcode = getVisibleUsageProvider('zcode', zcode, usageSettings)
  const showClaude =
    visibleClaude !== null &&
    statusBarItems.includes('claude') &&
    isStatusBarItemAvailable('claude', detectedAgentIds)
  const showCodex =
    visibleCodex !== null &&
    statusBarItems.includes('codex') &&
    isStatusBarItemAvailable('codex', detectedAgentIds)
  const showGemini =
    visibleGemini !== null &&
    statusBarItems.includes('gemini') &&
    isStatusBarItemAvailable('gemini', detectedAgentIds)
  const showKimi =
    visibleKimi !== null &&
    statusBarItems.includes('kimi') &&
    isStatusBarItemAvailable('kimi', detectedAgentIds)
  const showAntigravity =
    visibleAntigravity !== null &&
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Why: MiniMax is cookie-auth, not a CLI on PATH, so detection-gating doesn't apply.
  const showMiniMax = visibleMiniMax !== null && statusBarItems.includes('minimax')
  // Why: DeepSeek and Fireworks are API-key providers, not installed agent CLIs; a
  // PATH detection gate would hide them forever.
  const visibleDeepSeek = getVisibleUsageProvider('deepseek', deepseek, usageSettings)
  const visibleFireworks = getVisibleUsageProvider('fireworks', fireworks, usageSettings)
  // Why: Copilot is a token provider too — no CLI on PATH, so no detection gate.
  const visibleCopilot = getVisibleUsageProvider('copilot', copilot, usageSettings)
  const showDeepSeek = visibleDeepSeek !== null && statusBarItems.includes('deepseek')
  const showFireworks = visibleFireworks !== null && statusBarItems.includes('fireworks')
  const showCopilot = visibleCopilot !== null && statusBarItems.includes('copilot')
  const showGrok =
    visibleGrok !== null &&
    statusBarItems.includes('grok') &&
    isStatusBarItemAvailable('grok', detectedAgentIds)
  // Why: a Cursor session can come from the IDE alone, so PATH detection of
  // cursor-agent would hide a real meter from IDE-only users.
  const showCursor = visibleCursor !== null && statusBarItems.includes('cursor')
  const showZcode =
    visibleZcode !== null &&
    statusBarItems.includes('zcode') &&
    isStatusBarItemAvailable('zcode', detectedAgentIds)
  // Why: OpenCode Go is web/cookie-auth, not a CLI on PATH, so detection-gating doesn't apply.
  const visibleOpencodeGo = getVisibleUsageProvider('opencode-go', opencodeGo, usageSettings)
  const showOpencodeGo = visibleOpencodeGo !== null && statusBarItems.includes('opencode-go')
  // Why: meter-only children (excludes resource-usage) so the % display callout anchors to a real meter cluster.
  const hasVisibleUsageMeters =
    showClaude ||
    showCodex ||
    showGemini ||
    showOpencodeGo ||
    showKimi ||
    showAntigravity ||
    showMiniMax ||
    showGrok ||
    showCursor ||
    showZcode ||
    showDeepSeek ||
    showFireworks ||
    showCopilot
  // Why: include Settings so durable managed accounts count — a configured user isn't shown the empty state while snapshots hydrate.
  const isEmptyUsageState = isUsageEmptyState(
    {
      claude,
      codex,
      gemini,
      opencodeGo,
      kimi,
      antigravity,
      minimax,
      grok,
      cursor,
      zcode,
      deepseek,
      fireworks,
      copilot
    },
    usageSettings
  )
  // Why: one-time nudge — once dismissed, stays hidden even if providers reconnect later.
  const showEmptyUsageCta = isEmptyUsageState && !usageEmptyStateDismissed
  const anyFetching =
    claude?.status === 'fetching' ||
    codex?.status === 'fetching' ||
    gemini?.status === 'fetching' ||
    opencodeGo?.status === 'fetching' ||
    kimi?.status === 'fetching' ||
    antigravity?.status === 'fetching' ||
    minimax?.status === 'fetching' ||
    grok?.status === 'fetching' ||
    cursor?.status === 'fetching' ||
    zcode?.status === 'fetching' ||
    deepseek?.status === 'fetching' ||
    fireworks?.status === 'fetching' ||
    copilot?.status === 'fetching'

  // Why: the roster must contain only status items the user left visible;
  // otherwise an empty trigger would bypass those visibility controls.
  const rosterProviders = [
    showClaude ? visibleClaude : null,
    showCodex ? visibleCodex : null,
    showGemini ? visibleGemini : null,
    showAntigravity ? visibleAntigravity : null,
    showOpencodeGo ? visibleOpencodeGo : null,
    showKimi ? visibleKimi : null,
    showMiniMax ? visibleMiniMax : null,
    showGrok ? visibleGrok : null,
    showCursor ? visibleCursor : null,
    showZcode ? visibleZcode : null,
    showDeepSeek ? visibleDeepSeek : null,
    showFireworks ? visibleFireworks : null,
    showCopilot ? visibleCopilot : null
  ].filter((p): p is ProviderRateLimits => p !== null)

  return {
    anyFetching,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    rosterProviders,
    showEmptyUsageCta
  }
}
