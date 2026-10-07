import { antigravityUsageDisabledSnapshot } from '../antigravity-usage-snapshot'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { InternalRateLimitState, ProviderRateLimits } from './service-types'

/** The two pieces of fetch-cycle bookkeeping a full cycle needs but that carry no
 *  provider logic of their own: which in-flight fetch each generation stamp
 *  belongs to, and the state a cycle publishes while every provider is fetching. */
export abstract class RateLimitServiceCycleFetchState extends RateLimitServiceFetchPolicy {
  /** Bump a provider's fetch generation when its credential fingerprint moved, and
   *  answer the generation an in-flight fetch is stamped with. A stale response
   *  whose stamp no longer matches is discarded by the apply phase. */
  protected syncOpencodeFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastOpencodeConfigHash) {
      this.lastOpencodeConfigHash = fingerprint
      this.opencodeFetchGeneration += 1
    }
    return this.opencodeFetchGeneration
  }

  protected syncMiniMaxFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastMiniMaxConfigHash) {
      this.lastMiniMaxConfigHash = fingerprint
      this.minimaxFetchGeneration += 1
    }
    return this.minimaxFetchGeneration
  }

  protected syncZcodeFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastZcodeConfigHash) {
      this.lastZcodeConfigHash = fingerprint
      this.zcodeFetchGeneration += 1
    }
    return this.zcodeFetchGeneration
  }

  protected syncDeepSeekFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastDeepSeekConfigHash) {
      this.lastDeepSeekConfigHash = fingerprint
      this.deepseekFetchGeneration += 1
    }
    return this.deepseekFetchGeneration
  }

  protected syncFireworksFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastFireworksConfigHash) {
      this.lastFireworksConfigHash = fingerprint
      this.fireworksFetchGeneration += 1
    }
    return this.fireworksFetchGeneration
  }

  protected syncCopilotFetchGeneration(fingerprint: string): number {
    if (fingerprint !== this.lastCopilotConfigHash) {
      this.lastCopilotConfigHash = fingerprint
      this.copilotFetchGeneration += 1
    }
    return this.copilotFetchGeneration
  }

  /** Mark every provider as fetching while its previous data stays visible, so the
   *  meters do not blink empty for the length of a cycle.
   *
   *  A provider whose credential fingerprint moved loses its snapshot — that reading
   *  belonged to the old credential. Codex is the exception either way: a gated
   *  Codex makes no attempt, so a "fetching" chip would never settle. */
  protected markProvidersFetching(args: {
    previousState: InternalRateLimitState
    codexFetchGated: boolean
    codexStateBeforeFetch: ProviderRateLimits | null
    antigravityUsageEnabled: boolean
    changed: Record<
      'opencodeGo' | 'minimax' | 'deepseek' | 'fireworks' | 'copilot' | 'zcode',
      boolean
    >
  }): void {
    const {
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      antigravityUsageEnabled,
      changed
    } = args
    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude'),
      // Why: a gated Codex cycle makes no attempt; a "fetching" chip would never settle.
      codex: codexFetchGated
        ? codexStateBeforeFetch
        : this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: this.withFetchingStatus(previousState.gemini, 'gemini'),
      opencodeGo: changed.opencodeGo
        ? this.withFetchingStatus(null, 'opencode-go')
        : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go'),
      kimi: this.withFetchingStatus(previousState.kimi, 'kimi'),
      antigravity: antigravityUsageEnabled
        ? this.withFetchingStatus(previousState.antigravity, 'antigravity')
        : (previousState.antigravity ?? antigravityUsageDisabledSnapshot()),
      minimax: changed.minimax
        ? this.withFetchingStatus(null, 'minimax')
        : this.withFetchingStatus(previousState.minimax, 'minimax'),
      deepseek: changed.deepseek
        ? this.withFetchingStatus(null, 'deepseek')
        : this.withFetchingStatus(previousState.deepseek, 'deepseek'),
      fireworks: changed.fireworks
        ? this.withFetchingStatus(null, 'fireworks')
        : this.withFetchingStatus(previousState.fireworks, 'fireworks'),
      copilot: changed.copilot
        ? this.withFetchingStatus(null, 'copilot')
        : this.withFetchingStatus(previousState.copilot, 'copilot'),
      grok: this.withFetchingStatus(previousState.grok, 'grok'),
      cursor: this.withFetchingStatus(previousState.cursor, 'cursor'),
      zcode: changed.zcode
        ? this.withFetchingStatus(null, 'zcode')
        : this.withFetchingStatus(previousState.zcode, 'zcode'),
      // Why: a disabled provider holds no snapshot at all, so a prior reading cannot linger.
      ...this.disabledUsageProviderStateOverrides()
    })
  }
}
