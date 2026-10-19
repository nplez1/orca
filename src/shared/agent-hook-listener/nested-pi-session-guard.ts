import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import type { AgentHookEventPayload } from './listener-event'

/** The one event that legitimately hands a pane to a different pi session.
 *
 *  pi posts `session_start` when a session takes the pane over — /new, a resume, a fork — so it is
 *  the only post that may move the owner. Every other event from a second session in the same
 *  process is a nested session's, and must not speak for the pane. */
const PI_PANE_OWNERSHIP_EVENTS = new Set(['session_start'])

/**
 * Whether this pi event comes from a session nested inside the pane's own agent rather than from
 * the agent itself.
 *
 * A claude-backed subagent's runner is an in-process pi session of its own, and its tool activity
 * reaches the pane the runner inherited. Because a pi post carries the FULL live child set of the
 * session that posted it, and the nested session has no children, taking that field literally
 * replaces the pane's roster with nothing: the child row vanishes mid-run while the child is still
 * working. Measured, not inferred — a packet capture of the hook traffic shows the parent's posts
 * naming run-1 and the runner's own posts arriving with an empty set, which is when the row goes.
 *
 * The caller refuses such a post outright, and only while this pane still holds a live child run:
 * a runner session exists only while a child of this pane runs, so that is what makes a second
 * session recognisable as one. Keying the refusal on the session id alone would be permanent — pi's
 * transport keeps only the newest post (`agent-status-extension-source.ts` coalesces to one pending
 * slot), so a `session_start` can be overwritten and never arrive, and the refusal would then pin
 * the pane to a session the user already left. Two things bound it instead: the roster is pruned
 * before it is read, and the post that rides an ending session's own live set drains it.
 *
 * Narrow on purpose: only `pi`. omp and prime-agent share the normalizer but not this extension
 * topology, and a provider that legitimately posts several sessions per pane must not be muted by a
 * rule written for one of them. */
export function isNestedPiSessionEvent(args: {
  previousStatus: Pick<AgentHookEventPayload, 'providerSession'> | undefined
  source: AgentHookSource
  providerSession: AgentProviderSessionMetadata | null
  eventName: unknown
}): boolean {
  if (args.source !== 'pi') {
    return false
  }
  const incoming = args.providerSession?.id
  const owner = args.previousStatus?.providerSession?.id
  if (!incoming || !owner || incoming === owner) {
    return false
  }
  // Why an absent event name is not the owner moving: an unnamed post is a fragment of the pane's
  // own stream, and the next named post settles which session it belonged to.
  const eventName = typeof args.eventName === 'string' ? args.eventName : undefined
  return eventName !== undefined && !PI_PANE_OWNERSHIP_EVENTS.has(eventName)
}
