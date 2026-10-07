import { describe, expect, it } from 'vitest'
import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import {
  readSessionSummaryDiscoveredModels,
  resolveSessionSummaryAiParams,
  type SessionSummaryAiSettingsInput
} from './session-summary-ai'
import type { SessionSummaryAiSettings } from './session-summary-ai-types'

const CLAUDE_DEFAULT_MODEL = getCommitMessageAgentSpec('claude')?.defaultModelId ?? ''

function config(overrides: Partial<SessionSummaryAiSettings> = {}): SessionSummaryAiSettings {
  return {
    agentId: null,
    selectedModelByAgent: {},
    selectedThinkingByModel: {},
    customAgentCommand: '',
    ...overrides
  }
}

function input(
  overrides: Partial<SessionSummaryAiSettingsInput> = {}
): SessionSummaryAiSettingsInput {
  return overrides
}

describe('resolveSessionSummaryAiParams', () => {
  it('falls back to the default agent, its default model, and its default effort', () => {
    expect(resolveSessionSummaryAiParams(input())).toEqual({
      agentId: 'claude',
      model: CLAUDE_DEFAULT_MODEL,
      thinkingLevel: 'low'
    })
  })

  it('honours the configured agent, model, and effort', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'claude',
          selectedModelByAgent: { claude: 'opus' },
          selectedThinkingByModel: { opus: 'high' }
        })
      })
    )

    expect(resolved).toEqual({ agentId: 'claude', model: 'opus', thinkingLevel: 'high' })
  })

  // A dynamic agent can offer models the static list does not know (discovered later).
  it('passes an unknown model through for a dynamic agent', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'claude',
          selectedModelByAgent: { claude: 'claude-9000' }
        })
      })
    )

    expect(resolved?.model).toBe('claude-9000')
  })

  it('falls back to the default model when a static agent no longer offers the stored one', () => {
    const copilot = getCommitMessageAgentSpec('copilot')
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'copilot',
          selectedModelByAgent: { copilot: 'copilot-9000' }
        })
      })
    )

    expect(resolved?.model).toBe(copilot?.defaultModelId)
  })

  it('falls back to the model default when the stored effort is not offered', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'claude',
          selectedModelByAgent: { claude: 'opus' },
          selectedThinkingByModel: { opus: 'ludicrous' }
        })
      })
    )

    expect(resolved?.thinkingLevel).toBe('low')
  })

  it('omits the effort for a model that has none', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'claude',
          selectedModelByAgent: { claude: 'haiku' }
        })
      })
    )

    expect(resolved).toEqual({ agentId: 'claude', model: 'haiku' })
  })

  it('requires a command for the custom agent', () => {
    expect(
      resolveSessionSummaryAiParams(
        input({ sessionSummaryAi: config({ agentId: 'custom', customAgentCommand: '   ' }) })
      )
    ).toBeNull()

    expect(
      resolveSessionSummaryAiParams(
        input({
          sessionSummaryAi: config({
            agentId: 'custom',
            customAgentCommand: 'ollama run llama3.1'
          })
        })
      )
    ).toEqual({ agentId: 'custom', model: '', customAgentCommand: 'ollama run llama3.1' })
  })

  it('returns null when the configured and fallback agents are both disabled', () => {
    expect(
      resolveSessionSummaryAiParams(
        input({ defaultTuiAgent: 'blank', disabledTuiAgents: ['claude'] })
      )
    ).toBeNull()
  })

  it('passes the agent command override through', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({ agentCmdOverrides: { claude: '  /opt/claude  ' } })
    )

    expect(resolved?.agentCommandOverride).toBe('/opt/claude')
  })

  // The probe is what the picker showed the user, so it is what the fold must run.
  it('honours a probed model and the effort the user picked for it', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'pi',
          selectedModelByAgent: { pi: 'deepseek/deepseek-flash' },
          selectedThinkingByModel: { 'deepseek/deepseek-flash': 'high' },
          discoveredModelsByAgent: {
            pi: [
              {
                id: 'deepseek/deepseek-flash',
                label: 'Deepseek Flash',
                thinkingLevels: [
                  { id: 'low', label: 'Low' },
                  { id: 'high', label: 'High' }
                ],
                defaultThinkingLevel: 'low'
              }
            ]
          }
        })
      })
    )

    expect(resolved).toEqual({
      agentId: 'pi',
      model: 'deepseek/deepseek-flash',
      thinkingLevel: 'high'
    })
  })

  it('uses the probed default effort for a probed model with no stored pick', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'pi',
          selectedModelByAgent: { pi: 'deepseek/deepseek-flash' },
          discoveredModelsByAgent: {
            pi: [
              {
                id: 'deepseek/deepseek-flash',
                label: 'Deepseek Flash',
                thinkingLevels: [{ id: 'medium', label: 'Medium' }],
                defaultThinkingLevel: 'medium'
              }
            ]
          }
        })
      })
    )

    expect(resolved?.thinkingLevel).toBe('medium')
  })

  it('falls back to the agent default when the probe no longer lists the stored model', () => {
    const resolved = resolveSessionSummaryAiParams(
      input({
        sessionSummaryAi: config({
          agentId: 'pi',
          selectedModelByAgent: { pi: 'deepseek/retired-model' },
          discoveredModelsByAgent: {
            pi: [{ id: 'deepseek/deepseek-flash', label: 'Deepseek Flash' }]
          }
        })
      })
    )

    expect(resolved?.model).toBe('default')
    expect(resolved?.thinkingLevel).toBeUndefined()
  })
})

describe('readSessionSummaryDiscoveredModels', () => {
  const models = [{ id: 'deepseek/deepseek-flash', label: 'Deepseek Flash' }]

  it('reads the local slot first', () => {
    expect(
      readSessionSummaryDiscoveredModels(
        {
          sessionSummaryAi: config({
            discoveredModelsByAgent: { pi: models },
            discoveredModelsByAgentByHost: {
              'ssh:host-1': { pi: [{ id: 'remote', label: 'Remote' }] }
            }
          })
        },
        'pi'
      )
    ).toEqual(models)
  })

  it('falls back to the local host slot', () => {
    expect(
      readSessionSummaryDiscoveredModels(
        {
          sessionSummaryAi: config({
            discoveredModelsByAgentByHost: { local: { pi: models } }
          })
        },
        'pi'
      )
    ).toEqual(models)
  })

  it('reports nothing before a probe has run', () => {
    expect(readSessionSummaryDiscoveredModels({ sessionSummaryAi: config() }, 'pi')).toEqual([])
    expect(readSessionSummaryDiscoveredModels({}, 'pi')).toEqual([])
  })
})
