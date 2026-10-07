import { describe, expect, it } from 'vitest'
import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import {
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
})
