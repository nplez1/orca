import { beforeEach, describe, expect, it, vi } from 'vitest'
import replayEvents from './__fixtures__/copilot-nested-background-replay.json'
import { _internals } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => null) }))

const REPLAY_EVENTS: Record<string, unknown>[] = replayEvents

beforeEach(() => {
  _internals.resetCachesForTests()
})

/**
 * Replays a real Copilot CLI 1.0.87 capture (lead → background subagent → nested background
 * subagent → async shell, then the shell read to completion with read_bash, then the nested
 * SubagentStop/Stop chain). Copilot suppresses `shell_completed` when the agent reads the shell
 * itself, so this is the case that stranded a pane in "Monitoring background tasks".
 */
describe('Copilot real nested background replay', () => {
  function replay(): (string | null)[] {
    return REPLAY_EVENTS.map(
      (payload) =>
        _internals.normalizeHookPayload(
          'copilot',
          { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', env: 'production', payload },
          'production'
        )?.payload.state ?? null
    )
  }

  it('never lets a subagent event settle the lead pane', () => {
    const states = replay()

    // The deepest child's Stop and the nested SubagentStop are child-session events.
    expect(states[14]).toBeNull()
    expect(states[17]).toBeNull()
  })

  it('settles the lead turn after its shell is read to completion', () => {
    const states = replay()

    // The final lead Stop must be `done`, not a stuck `working`/monitoring from the shell that the
    // read_bash completion consumed without a `shell_completed` notification.
    expect(states.at(-2)).toBe('done')
  })
})
