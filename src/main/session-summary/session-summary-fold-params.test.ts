import { describe, expect, it } from 'vitest'
import { getDefaultSourceControlAiSettings } from '../../shared/source-control-ai-settings'
import type { SessionSummaryAiSettings } from '../../shared/session-summary-ai-types'
import {
  resolveSessionSummaryFoldParams,
  type SessionSummaryFoldSettings
} from './session-summary-fold-params'

function summaryAi(overrides: Partial<SessionSummaryAiSettings> = {}): SessionSummaryAiSettings {
  return {
    agentId: null,
    selectedModelByAgent: {},
    selectedThinkingByModel: {},
    customAgentCommand: '',
    ...overrides
  }
}

function foldSettings(
  overrides: Partial<SessionSummaryFoldSettings> = {}
): SessionSummaryFoldSettings {
  return {
    defaultTuiAgent: 'claude',
    agentCmdOverrides: {},
    sessionSummaryAi: summaryAi(),
    ...overrides
  }
}

describe('resolveSessionSummaryFoldParams', () => {
  it('follows the session-summary agent, model, and effort', () => {
    const params = resolveSessionSummaryFoldParams(
      foldSettings({
        sessionSummaryAi: summaryAi({
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedThinkingByModel: { 'gpt-5.4': 'high' }
        })
      })
    )

    expect(params).toMatchObject({ agentId: 'codex', model: 'gpt-5.4', thinkingLevel: 'high' })
  })

  it('falls back to the default agent when nothing is configured', () => {
    expect(resolveSessionSummaryFoldParams(foldSettings())?.agentId).toBe('claude')
  })

  // The point of the separate setting: tuning commit messages must not move the fold.
  it('ignores the source-control AI choice entirely', () => {
    // A wider object than the resolver reads, so an accidental read still typechecks.
    const settings = {
      ...foldSettings({ sessionSummaryAi: undefined }),
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        agentId: 'codex' as const,
        selectedModelByAgent: { codex: 'gpt-5.4' }
      }
    }

    expect(resolveSessionSummaryFoldParams(settings)?.agentId).toBe('claude')
  })

  it('passes a custom agent command through', () => {
    const params = resolveSessionSummaryFoldParams(
      foldSettings({
        sessionSummaryAi: summaryAi({
          agentId: 'custom',
          customAgentCommand: 'my-llm --print'
        })
      })
    )

    expect(params).toMatchObject({ agentId: 'custom', customAgentCommand: 'my-llm --print' })
  })

  it('returns null for a custom agent with no command', () => {
    expect(
      resolveSessionSummaryFoldParams(
        foldSettings({ sessionSummaryAi: summaryAi({ agentId: 'custom' }) })
      )
    ).toBeNull()
  })
})
