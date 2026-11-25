import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isNeverTaskedAgentSession } from './never-tasked-agent-session'

// A wrong "empty" silently kills real work, so every single piece of work evidence must keep the prompt.
const boundary: AgentStatusEntry = {
  state: 'done',
  sessionBoundary: true,
  prompt: '',
  updatedAt: 1_000,
  stateStartedAt: 1_000,
  agentType: 'claude',
  paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
  stateHistory: [],
  mainAgent: { state: 'done', stateStartedAt: 1_000 }
}

const workEvidence: Partial<AgentStatusEntry>[] = [
  { agentType: 'unknown' },
  { restoredUnconfirmed: true },
  { state: 'working', sessionBoundary: undefined },
  { state: 'blocked', sessionBoundary: undefined },
  { sessionBoundary: undefined },
  { stateHistory: [{ state: 'working', prompt: 'x', startedAt: 1 }] },
  { turnStartedAt: 900 },
  { turnEndedAt: 900 },
  { prompt: 'fix the bug' },
  { lastAssistantMessage: 'done' },
  { lastCompletedAssistantMessage: 'done' },
  { interactivePrompt: '{}' },
  { toolName: 'Bash' },
  { subagents: [{ id: 'a', state: 'working', startedAt: 900 }] },
  { orchestration: { taskId: 't', dispatchId: 'd' } },
  { mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1_000 } },
  { mainAgent: { state: 'working', stateStartedAt: 1_000 } }
]

describe('isNeverTaskedAgentSession', () => {
  const fresh = { entry: boundary, launchedPromptFree: true, lastUserInputAt: undefined }

  it('excuses only a prompt-free launch resting at its first session boundary', () => {
    expect(isNeverTaskedAgentSession(fresh)).toBe(true)
    expect(isNeverTaskedAgentSession({ ...fresh, entry: undefined })).toBe(false)
    expect(isNeverTaskedAgentSession({ ...fresh, launchedPromptFree: false })).toBe(false)
    expect(isNeverTaskedAgentSession({ ...fresh, lastUserInputAt: 900 })).toBe(false)
    for (const change of workEvidence) {
      expect(isNeverTaskedAgentSession({ ...fresh, entry: { ...boundary, ...change } })).toBe(false)
    }
  })
})
