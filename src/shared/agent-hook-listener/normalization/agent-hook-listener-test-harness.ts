import { normalizeHookPayload } from './normalize-hook-payload'
import { admitLegacyAgentStatus, type HookListenerState } from '../listener-state'
import type { AgentHookEventPayload } from '../listener-event'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../agent-status/transport/agent-status-legacy-adapter'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

/** Test harnesses seed the same compatibility region without exposing a mutable Map. */
export function seedLegacyAgentStatusForTests(
  state: HookListenerState,
  entry: AgentHookEventPayload
): void {
  if (
    !admitLegacyAgentStatus(
      state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  ) {
    throw new Error('Test legacy agent-status seed was refused')
  }
}

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
export const CLAUDE_PROMPT_ID = '22222222-2222-4222-8222-222222222222'
export const CLAUDE_PREVIOUS_PROMPT_ID = '33333333-3333-4333-8333-333333333333'

export function normalizeAndAccept(
  state: HookListenerState,
  source: Parameters<typeof normalizeHookPayload>[1],
  payload: Record<string, unknown>,
  options: Parameters<typeof normalizeHookPayload>[4] = {}
): ReturnType<typeof normalizeHookPayload> {
  const event = normalizeHookPayload(
    state,
    source,
    { paneKey: PANE_KEY, payload },
    'production',
    options
  )
  if (event) {
    seedLegacyAgentStatusForTests(state, event)
  }
  return event
}
