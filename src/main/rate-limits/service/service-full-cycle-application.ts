import { RateLimitServiceFullCyclePreparation } from './service-full-cycle-preparation'
import { providerResultSnapshot } from './service-provider-result-snapshot'
import { applyForkProviderCycle } from '../fork/fork-provider-cycle'
import { isZcodeUsageCredentialCurrent } from '../zcode-usage-credentials'
import { settleSiblingProviderResult } from './service-sibling-provider-result'

export abstract class RateLimitServiceFullCycleApplication extends RateLimitServiceFullCyclePreparation {
  protected async runFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    const prepared = await this.prepareFetchAllCycle(signal, options)
    if (!prepared) {
      return
    }
    const {
      claudeTarget,
      claudeGeneration,
      claudeProvenance,
      codexTarget,
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      codexProvenance,
      codexGeneration,
      opencodeConfigChanged,
      opencodeGeneration,
      miniMaxConfigChanged,
      miniMaxGeneration,
      zcodeConfigChanged,
      zcodeGeneration,
      forkProviderCycle,
      antigravityGeneration,
      claudeFetchGated,
      results: [
        claudeResult,
        codexResult,
        geminiResult,
        opencodeGoResult,
        kimiResult,
        miniMaxResult
      ],
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    } = prepared
    if (signal.aborted) {
      return
    }

    const claude = providerResultSnapshot('claude', claudeResult)

    const codex = providerResultSnapshot('codex', codexResult)

    const gemini = providerResultSnapshot('gemini', geminiResult)

    // Why the fallback: OpenCode Go reports its monthly window slot explicitly even when empty.
    const opencodeGo = providerResultSnapshot('opencode-go', opencodeGoResult, { monthly: null })

    const kimi = providerResultSnapshot('kimi', kimiResult)

    const miniMax = providerResultSnapshot('minimax', miniMaxResult)

    // Why: a disabled provider skips these late reads too — resolveCodexHome and the
    // Claude auth preparation both touch local credential homes after the fetch.
    const codexDisabled = this.isUsageProviderDisabled('codex')
    const claudeDisabled = this.isUsageProviderDisabled('claude')
    const latestCodexHome = codexDisabled
      ? { skip: true, homePath: null }
      : await this.resolveCodexHome(codexTarget)
    const latestClaudeAuthPreparation = claudeDisabled
      ? undefined
      : await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    // Skips have no provenance and must not reattribute in-flight usage to System Default (#STA-4422).
    const shouldApplyCodex =
      !codexDisabled &&
      !codexFetchGated &&
      !latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration &&
      codexProvenance === this.getCodexProvenance(codexTarget, latestCodexHome.homePath)
    const codexBecameUnavailable =
      !codexDisabled &&
      !codexFetchGated &&
      latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration
    // Gated Claude made no attempt; passthrough must not advance failure or stale-policy clocks.
    const shouldApplyClaude =
      !claudeDisabled &&
      !claudeFetchGated &&
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    const shouldApplyOpencode = opencodeGeneration === this.opencodeFetchGeneration
    const shouldApplyMiniMax = miniMaxGeneration === this.minimaxFetchGeneration

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claude)
    }
    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    this.trackActiveFailureStreak('gemini', gemini)
    if (shouldApplyOpencode) {
      this.trackActiveFailureStreak('opencode-go', opencodeGo)
    }
    this.trackActiveFailureStreak('kimi', kimi)
    if (shouldApplyMiniMax) {
      this.trackActiveFailureStreak('minimax', miniMax)
    }

    // Both generation and provenance must match before an in-flight Codex result can publish.
    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.resolveClaudeFetchApply(claude, previousState.claude)
        : this.state.claude,
      codex: shouldApplyCodex
        ? this.applyStalePolicy(codex, previousState.codex)
        : codexBecameUnavailable
          ? codexStateBeforeFetch
          : this.state.codex,
      gemini: this.applyStalePolicy(gemini, previousState.gemini),
      opencodeGo: shouldApplyOpencode
        ? opencodeConfigChanged
          ? opencodeGo
          : this.applyStalePolicy(opencodeGo, previousState.opencodeGo)
        : this.state.opencodeGo,
      kimi: this.applyStalePolicy(kimi, previousState.kimi),
      minimax: shouldApplyMiniMax
        ? miniMaxConfigChanged
          ? miniMax
          : this.applyStalePolicy(miniMax, previousState.minimax)
        : this.state.minimax
    })

    const [grokSettled, cursorSettled, zcodeSettled, antigravitySettled] = await Promise.all([
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    ])
    const { deepseek, fireworks, deepinfra, copilot } =
      await applyForkProviderCycle(forkProviderCycle)
    if (signal.aborted) {
      return
    }
    const grok = settleSiblingProviderResult('grok', grokSettled)
    const cursor = settleSiblingProviderResult('cursor', cursorSettled)
    const settledZcode = settleSiblingProviderResult('zcode', zcodeSettled)
    const zcode = isZcodeUsageCredentialCurrent(settledZcode)
      ? settledZcode
      : {
          ...settledZcode,
          status: 'unavailable' as const,
          session: null,
          weekly: null,
          monthly: null,
          error: 'ZCode Coding Plan account changed during refresh'
        }
    const shouldApplyZcode = zcodeGeneration === this.zcodeFetchGeneration
    const antigravity = settleSiblingProviderResult('antigravity', antigravitySettled)
    const shouldApplyAntigravity = antigravityGeneration === this.antigravityFetchGeneration
    // Discard Cursor stale usage only for a known account change; unidentified transient failures retain their last reading.
    const previousCursorAccount = previousState.cursor?.usageMetadata?.authProvenance
    const cursorAccount = cursor.usageMetadata?.authProvenance
    const cursorAccountChanged =
      previousCursorAccount !== undefined &&
      cursorAccount !== undefined &&
      previousCursorAccount !== cursorAccount
    const previousZcodeAccount = previousState.zcode?.usageMetadata?.authProvenance
    const zcodeAccount = zcode.usageMetadata?.authProvenance
    const sameZcodeAccount =
      previousZcodeAccount !== undefined &&
      zcodeAccount !== undefined &&
      previousZcodeAccount === zcodeAccount
    // Why: a credential paste between cycles must discard the in-flight result, or the old key's snapshot overwrites the new one.
    const shouldApplyDeepSeek =
      forkProviderCycle.deepSeek.generation === this.deepseekFetchGeneration
    const shouldApplyFireworks =
      forkProviderCycle.fireworks.generation === this.fireworksFetchGeneration
    const shouldApplyDeepInfra =
      forkProviderCycle.deepInfra.generation === this.deepinfraFetchGeneration
    const shouldApplyCopilot = forkProviderCycle.copilot.generation === this.copilotFetchGeneration
    this.trackActiveFailureStreak('grok', grok)
    this.trackActiveFailureStreak('cursor', cursor)
    if (shouldApplyZcode) {
      this.trackActiveFailureStreak('zcode', zcode)
    }
    if (shouldApplyAntigravity) {
      this.trackActiveFailureStreak('antigravity', antigravity)
    }
    if (shouldApplyDeepSeek) {
      this.trackActiveFailureStreak('deepseek', deepseek)
    }
    if (shouldApplyFireworks) {
      this.trackActiveFailureStreak('fireworks', fireworks)
    }
    if (shouldApplyDeepInfra) {
      this.trackActiveFailureStreak('deepinfra', deepinfra)
    }
    if (shouldApplyCopilot) {
      this.trackActiveFailureStreak('copilot', copilot)
    }
    this.updateState({
      ...this.state,
      grok: this.applyStalePolicy(grok, previousState.grok),
      cursor: cursorAccountChanged ? cursor : this.applyStalePolicy(cursor, previousState.cursor),
      zcode: !shouldApplyZcode
        ? this.state.zcode
        : zcodeConfigChanged
          ? zcode
          : zcode.status === 'error' && !sameZcodeAccount
            ? zcode
            : this.applyStalePolicy(zcode, previousState.zcode),
      antigravity: shouldApplyAntigravity
        ? this.applyStalePolicy(antigravity, previousState.antigravity)
        : this.state.antigravity,
      deepseek: shouldApplyDeepSeek
        ? forkProviderCycle.deepSeek.configChanged
          ? deepseek
          : this.applyStalePolicy(deepseek, previousState.deepseek)
        : this.state.deepseek,
      fireworks: shouldApplyFireworks
        ? forkProviderCycle.fireworks.configChanged
          ? fireworks
          : this.applyStalePolicy(fireworks, previousState.fireworks)
        : this.state.fireworks,
      deepinfra: shouldApplyDeepInfra
        ? forkProviderCycle.deepInfra.configChanged
          ? deepinfra
          : this.applyStalePolicy(deepinfra, previousState.deepinfra)
        : this.state.deepinfra,
      copilot: shouldApplyCopilot
        ? forkProviderCycle.copilot.configChanged
          ? copilot
          : this.applyStalePolicy(copilot, previousState.copilot)
        : this.state.copilot
    })
  }
}
