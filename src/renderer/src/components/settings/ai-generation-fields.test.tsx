// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  getCommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import type { AiGenerationSettingsConfig } from '@/lib/ai-generation-settings'
import { AiGenerationFields } from './ai-generation-fields'

const CLAUDE = getCommitMessageAgentCapability('claude')
const WITH_EFFORT: CommitMessageModelCapability = {
  id: 'opus',
  label: 'Opus',
  thinkingLevels: [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' }
  ],
  defaultThinkingLevel: 'low'
}
const WITHOUT_EFFORT: CommitMessageModelCapability = { id: 'haiku', label: 'Haiku' }

const CONFIG: AiGenerationSettingsConfig = {
  agentId: 'claude',
  selectedModelByAgent: { claude: 'opus' },
  selectedThinkingByModel: {},
  customAgentCommand: ''
}

function render(model: CommitMessageModelCapability | null, thinking?: string): string {
  return renderToStaticMarkup(
    <AiGenerationFields
      config={CONFIG}
      selectPortalRoot={null}
      agentSelectValue="claude"
      activeCapability={CLAUDE}
      activeModel={model}
      activeThinking={thinking}
      isCustom={false}
      unsupportedAgentLabel={null}
      onAgentChange={() => {}}
      onModelChange={() => {}}
      onThinkingChange={() => {}}
      onCustomCommandChange={() => {}}
    />
  )
}

describe('AiGenerationFields', () => {
  it('offers the effort levels the selected model declares', () => {
    const markup = render(WITH_EFFORT, 'high')

    expect(markup).toContain('Thinking effort')
    expect(markup).toContain('aria-expanded')
    expect(markup).not.toContain('This model has no effort setting.')
  })

  // The row stays visible so a model without the setting reads as exactly that.
  it('keeps the effort row, disabled, for a model that takes none', () => {
    const markup = render(WITHOUT_EFFORT)

    expect(markup).toContain('Thinking effort')
    expect(markup).toContain('This model has no effort setting.')
    expect(markup).toContain('data-disabled')
    expect(markup).toContain('—')
  })

  it('omits the effort row when no model is selected at all', () => {
    expect(render(null)).not.toContain('Thinking effort')
  })
})
