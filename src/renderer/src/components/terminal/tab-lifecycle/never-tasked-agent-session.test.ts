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
const fresh = { entry: boundary, launchedPromptFree: true, lastUserInputAt: undefined }

describe('isNeverTaskedAgentSession', () => {
  it('excuses only a prompt-free launch resting at its first session boundary', () => {
    expect(isNeverTaskedAgentSession(fresh)).toBe(true)
  })

  it.each<[string, Partial<Parameters<typeof isNeverTaskedAgentSession>[0]>]>([
    ['no status row', { entry: undefined }],
    ['launch not known to be prompt-free', { launchedPromptFree: false }],
    ['user typed into the pane', { lastUserInputAt: 900 }],
    ['unknown agent', { entry: { ...boundary, agentType: 'unknown' } }],
    ['restored, unconfirmed row', { entry: { ...boundary, restoredUnconfirmed: true } }],
    ['working', { entry: { ...boundary, state: 'working', sessionBoundary: undefined } }],
    ['blocked', { entry: { ...boundary, state: 'blocked', sessionBoundary: undefined } }],
    ['a finished turn', { entry: { ...boundary, sessionBoundary: undefined } }],
    [
      'turn history behind a /clear boundary',
      { entry: { ...boundary, stateHistory: [{ state: 'working', prompt: 'x', startedAt: 1 }] } }
    ],
    ['a turn clock', { entry: { ...boundary, turnStartedAt: 900 } }],
    ['a turn end', { entry: { ...boundary, turnEndedAt: 900 } }],
    ['a prompt', { entry: { ...boundary, prompt: 'fix the bug' } }],
    ['assistant output', { entry: { ...boundary, lastAssistantMessage: 'done' } }],
    ['completed output', { entry: { ...boundary, lastCompletedAssistantMessage: 'done' } }],
    ['an open question', { entry: { ...boundary, interactivePrompt: '{}' } }],
    ['a tool in use', { entry: { ...boundary, toolName: 'Bash' } }],
    [
      'child work',
      { entry: { ...boundary, subagents: [{ id: 'a', state: 'working', startedAt: 900 }] } }
    ],
    [
      'an orchestration dispatch',
      { entry: { ...boundary, orchestration: { taskId: 't', dispatchId: 'd' } } }
    ],
    [
      'a main-agent verdict',
      {
        entry: {
          ...boundary,
          mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1_000 }
        }
      }
    ],
    [
      'a working main agent',
      { entry: { ...boundary, mainAgent: { state: 'working', stateStartedAt: 1_000 } } }
    ]
  ])('keeps the prompt with %s', (_label, change) => {
    expect(isNeverTaskedAgentSession({ ...fresh, ...change })).toBe(false)
  })
})
