import { describe, expect, it } from 'vitest'
import { getCommitMessageAgentCapability } from '../../../shared/commit-message-agent-spec'
import type { CommitMessageModelCapability } from '../../../shared/commit-message-agent-spec'
import {
  resolveAiGenerationSelection,
  type AiGenerationSettingsConfig
} from './ai-generation-settings'

function config(overrides: Partial<AiGenerationSettingsConfig> = {}): AiGenerationSettingsConfig {
  return {
    agentId: null,
    selectedModelByAgent: {},
    selectedThinkingByModel: {},
    customAgentCommand: '',
    ...overrides
  }
}

const PROBED_PI_MODELS: CommitMessageModelCapability[] = [
  {
    id: 'deepseek/deepseek-flash',
    label: 'Deepseek Flash',
    thinkingLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' }
    ],
    defaultThinkingLevel: 'low'
  },
  { id: 'github-copilot/gpt-5.4', label: 'Github Copilot GPT 5.4' }
]

describe('resolveAiGenerationSelection', () => {
  it('uses the spec list when no probe has run', () => {
    const selection = resolveAiGenerationSelection(config({ agentId: 'pi' }), {
      defaultTuiAgent: 'claude'
    })

    expect(selection.activeCapability?.models.map((model) => model.id)).toEqual(['default'])
    expect(selection.activeThinking).toBeUndefined()
  })

  // Pi ships a single stub model; without this the picker cannot name a real one.
  it('replaces a dynamic agent stub with the probed models', () => {
    const selection = resolveAiGenerationSelection(config({ agentId: 'pi' }), {
      defaultTuiAgent: 'claude',
      discoveredModelsByAgent: { pi: PROBED_PI_MODELS }
    })

    expect(selection.activeCapability?.models.map((model) => model.id)).toEqual([
      'deepseek/deepseek-flash',
      'github-copilot/gpt-5.4'
    ])
    // The spec default ('default') is absent from the probe, so the first model wins.
    expect(selection.activeModel?.id).toBe('deepseek/deepseek-flash')
    expect(selection.activeThinking).toBe('low')
    expect(selection.isCustom).toBe(false)
  })

  it('keeps a probed model and its effort when the user picked them', () => {
    const selection = resolveAiGenerationSelection(
      config({
        agentId: 'pi',
        selectedModelByAgent: { pi: 'github-copilot/gpt-5.4' },
        selectedThinkingByModel: {}
      }),
      { defaultTuiAgent: 'claude', discoveredModelsByAgent: { pi: PROBED_PI_MODELS } }
    )

    expect(selection.activeModel?.id).toBe('github-copilot/gpt-5.4')
  })

  it('ignores probed models for an agent that did not report them', () => {
    const selection = resolveAiGenerationSelection(config({ agentId: 'copilot' }), {
      defaultTuiAgent: 'claude',
      discoveredModelsByAgent: { pi: PROBED_PI_MODELS }
    })

    expect(selection.activeCapability?.models.map((model) => model.id)).toContain('gpt-5.4')
    expect(selection.activeCapability?.models.map((model) => model.id)).not.toContain(
      'deepseek/deepseek-flash'
    )
  })

  it('falls back to the spec capability when only a custom agent is configured', () => {
    const selection = resolveAiGenerationSelection(config({ agentId: 'custom' }), {
      defaultTuiAgent: 'claude',
      discoveredModelsByAgent: { pi: PROBED_PI_MODELS }
    })

    expect(selection.isCustom).toBe(true)
    expect(selection.activeCapability).toBeUndefined()
    expect(selection.activeModel).toBeNull()
  })
})

describe('getCommitMessageAgentCapability', () => {
  it('reports Pi as dynamic so the pane knows to probe', () => {
    expect(getCommitMessageAgentCapability('pi')?.modelSource).toBe('dynamic')
    expect(getCommitMessageAgentCapability('copilot')?.modelSource).toBe('static')
  })
})
