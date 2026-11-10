import { describe, expect, it } from 'vitest'

import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { EnrichedAgentHookEventPayload } from '../server-types'
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS,
  programStatusHookYieldEndsAt
} from './hook-precedence'

const RECEIVED_AT = 1_000

const row = (payload: Partial<ParsedAgentStatusPayload>): ParsedAgentStatusPayload => ({
  state: 'working',
  prompt: '',
  agentType: 'pi',
  ...payload
})

function hookRow(payload: Partial<ParsedAgentStatusPayload>): EnrichedAgentHookEventPayload {
  return {
    paneKey: 'pane-1',
    source: 'pi',
    connectionId: null,
    payload: row(payload),
    receivedAt: RECEIVED_AT,
    stateStartedAt: RECEIVED_AT,
    observation: {
      origin: 'hook',
      authorityId: 'hook-1',
      incarnation: 1,
      revision: 1,
      observedAt: RECEIVED_AT
    }
  }
}

/** The child-held shape: the lead's own turn finished, and a live child keeps the row open. */
const HELD_BY_CHILD = {
  subagents: [{ id: 'run-1', state: 'working' as const, startedAt: RECEIVED_AT }],
  mainAgent: { state: 'done' as const, stateStartedAt: RECEIVED_AT }
}

describe('program status yields to a hook row held open by a live child', () => {
  it('keeps hook precedence past the silence window when the lead finished under a live child', () => {
    // Why Infinity: the pane's own program status (pi's TUI) settles the moment the turn ends, so a
    // held row that lapsed after two hook-silent minutes would hand the pane to a row that carries no
    // children at all — the pane reads done and its subagent row disappears while the child still runs.
    expect(programStatusHookYieldEndsAt(hookRow(HELD_BY_CHILD), row({ state: 'done' }))).toBe(
      Infinity
    )
  })

  it('still lapses on a plain working row, so a hook-silent tool call cannot pin the pane', () => {
    expect(programStatusHookYieldEndsAt(hookRow({}), row({ state: 'done' }))).toBe(
      RECEIVED_AT + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
    )
  })
})
