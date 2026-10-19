import { normalizeAgentStatusPayload } from '../agent-status-types'
import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import type { AgentHookEventPayload } from './listener-event'
import { readString } from './tool-input-preview'

const CLAUDE_EXIT_SESSION_END_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'other',
  'bypass_permissions_disabled'
])

/**
 * The status update a Claude `SessionEnd` that ends the process produces, or `undefined` when this
 * event is not one.
 *
 * Split out of agent-hook-listener.ts, which sits on the max-lines budget: the decision is
 * self-contained, and it is the only place a bare `SessionEnd` payload is allowed to become the
 * pane's own end rather than an ordinary status update.
 */
export function claudeSessionExitEvent(args: {
  eventName: unknown
  hookPayload: Record<string, unknown>
  agentPresence: AgentHookEventPayload['agentPresence'] | undefined
  previousStatus: Pick<AgentHookEventPayload, 'payload'> | undefined
  source: AgentHookSource
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
  providerSession: AgentProviderSessionMetadata | null
}): AgentHookEventPayload | null | undefined {
  if (
    args.eventName !== 'SessionEnd' ||
    !args.agentPresence ||
    // A child's own SessionEnd names the agent it belongs to, and must never end the pane.
    readString(args.hookPayload, 'agent_id') !== undefined
  ) {
    return undefined
  }
  const sessionEndReason = readString(args.hookPayload, 'reason')
  // Why: only reasons that end the process; /clear and /resume keep it running, and an unknown
  // reason is left to the process check rather than guessed.
  if (sessionEndReason === undefined || !CLAUDE_EXIT_SESSION_END_REASONS.has(sessionEndReason)) {
    return undefined
  }
  const payload =
    args.previousStatus?.payload ??
    normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: args.source })
  if (!payload) {
    return null
  }
  return {
    paneKey: args.paneKey,
    source: args.source,
    launchToken: args.launchToken,
    tabId: args.tabId,
    worktreeId: args.worktreeId,
    connectionId: null,
    ...(args.providerSession ? { providerSession: args.providerSession } : {}),
    hookEventName: 'SessionEnd',
    agentPresence: { ...args.agentPresence, ended: true as const },
    payload
  }
}
