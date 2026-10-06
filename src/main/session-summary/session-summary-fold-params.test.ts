import { describe, expect, it } from 'vitest'
import { getDefaultSourceControlAiSettings } from '../../shared/source-control-ai-settings'
import {
  resolveSessionSummaryFoldParams,
  type SessionSummaryFoldSettings
} from './session-summary-fold-params'

function foldSettings(
  sourceControlAi = getDefaultSourceControlAiSettings()
): SessionSummaryFoldSettings {
  return {
    defaultTuiAgent: 'claude',
    agentCmdOverrides: {},
    sourceControlAi
  }
}

describe('resolveSessionSummaryFoldParams', () => {
  it('follows the configured text-generation agent and model', () => {
    const params = resolveSessionSummaryFoldParams(
      foldSettings({
        ...getDefaultSourceControlAiSettings(),
        agentId: 'codex',
        selectedModelByAgent: { codex: 'gpt-5.4' }
      })
    )
    expect(params).toMatchObject({ agentId: 'codex', model: 'gpt-5.4' })
  })

  it('falls back to the default agent when none is configured', () => {
    const params = resolveSessionSummaryFoldParams(foldSettings())
    expect(params?.agentId).toBe('claude')
  })

  it('passes a custom agent command through', () => {
    const params = resolveSessionSummaryFoldParams(
      foldSettings({
        ...getDefaultSourceControlAiSettings(),
        agentId: 'custom',
        customAgentCommand: 'my-llm --print {prompt}'
      })
    )
    expect(params).toMatchObject({
      agentId: 'custom',
      customAgentCommand: 'my-llm --print {prompt}'
    })
  })
})
