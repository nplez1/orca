import type { AgentHookSource } from './transport/agent-hook-relay'
import {
  finishAgentDescendant,
  pruneStaleAgentDescendants,
  replaceAgentDescendants,
  upsertAgentDescendant,
  type AgentDescendantRoster
} from '../agent-descendant-roster'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../agent-status/contracts/agent-status-types'
import type { DescendantEntry, DescendantEventFacts } from './descendant-events'
import { deleteLegacyAgentStatus, type HookListenerState } from './listener-state'
import {
  carriedReportedChildren,
  paneChildSnapshots,
  rememberReportedChildren,
  resolvePaneHold
} from './pane-child-roster'

function getOrCreateDescendantRoster(
  state: HookListenerState,
  paneKey: string
): AgentDescendantRoster {
  let roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.descendantRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

/** Apply a descendant's lifecycle event: it updates the child list and republishes
 *  the pane from the LEAD's last known state, so a child finishing can never be the
 *  pane's completion. The lead's own tool/prompt caches are left untouched — a
 *  child's tool call is not the pane's, and overwriting them would relabel the row
 *  with the child's work. */
export function applyDescendantEventToPane(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  facts: DescendantEventFacts
): ParsedAgentStatusPayload | null {
  const now = Date.now()
  if (facts.kind === 'live-set') {
    const roster = getOrCreateDescendantRoster(state, paneKey)
    rememberRetiredDescendants(
      state,
      paneKey,
      roster,
      new Set(facts.children.map((c) => c.id)),
      now
    )
    replaceAgentDescendants(roster, facts.children, now)
    // Why only when the fact carries one: a live-set post is the pane's own lane, so its absent
    // list means none, while a child fact carries no list and must keep the one last reported.
    if (facts.reported !== undefined) {
      rememberReportedChildren(state, paneKey, facts.reported, now)
    }
  } else if (facts.id) {
    if (facts.ended) {
      const roster = state.descendantRosterByPaneKey.get(paneKey) ?? new Map()
      const tracked = roster.get(facts.id.trim())
      rememberRetiredDescendant(state, paneKey, tracked?.providerSession, now)
      finishAgentDescendant(roster, facts.id)
    } else {
      upsertAgentDescendant(
        getOrCreateDescendantRoster(state, paneKey),
        facts.id,
        {
          agentType: facts.agentType,
          description: facts.description,
          model: facts.model,
          providerSession: facts.providerSession,
          toolName: facts.toolName,
          toolInput: facts.toolInput,
          ...(facts.toolEnded === true ? { clearTool: true } : {}),
          state: facts.waiting === true ? 'waiting' : 'working'
        },
        now
      )
    }
  }
  dropEmptyDescendantRoster(state, paneKey, now)
  const children = paneChildSnapshots(state, paneKey, carriedReportedChildren(state, paneKey, now))

  // Why: a child's END with no lead state has nothing to gate on. Publishing `working`
  // from it would let a stray child completion relabel a pane whose own turn nobody has
  // described, and no later child event could settle it — the grok contract is that a
  // child's terminal events are ignored. Starts still prove the pane is working.
  const leadState = state.descendantLeadStateByPaneKey.get(paneKey)
  // Why: nothing left can justify a row, and nothing ever described the pane's own turn — the only
  // row that can be standing is the hold this lane published, which no event is left to clear.
  const nothingClaimsThePane =
    leadState === undefined &&
    !state.descendantRosterByPaneKey.has(paneKey) &&
    children.length === 0
  if (facts.kind === 'child' && facts.ended === true && leadState === undefined) {
    if (nothingClaimsThePane) {
      retractDescendantHoldRow(state, paneKey)
    }
    return null
  }
  // Why: an empty live set is not evidence of work either. Defaulting to `working` here is what
  // strands a pane whose scope reset dropped the lead's verdict — its last child leaves the set,
  // and the row is held open by a state nobody reported. Nothing is claimed instead, so the pane
  // keeps its own verdict rather than inheriting one from the absence of it.
  if (facts.kind === 'live-set' && nothingClaimsThePane) {
    retractDescendantHoldRow(state, paneKey)
    return null
  }

  // Why: a child event before any lead event still proves the pane is working — the lead spawned it.
  const effectiveLeadState = leadState ?? 'working'
  const cachedTool = state.lastToolByPaneKey.get(paneKey) ?? {}
  const payload = normalizeAgentStatusPayload({
    state: effectiveLeadState,
    prompt: state.lastPromptByPaneKey.get(paneKey) ?? '',
    // Why the pane's own type rather than the reporter's: this is the first descendant lane whose
    // reporter can be a DIFFERENT provider from the lead (a claude CLI child of a pi run), and
    // stamping the reporter's would relabel the pane's row as the child the event was about.
    agentType: state.lastStatusByPaneKey.get(paneKey)?.payload.agentType ?? source,
    toolName: cachedTool.toolName,
    toolInput: cachedTool.toolInput,
    interactivePrompt: cachedTool.interactivePrompt,
    lastAssistantMessage: cachedTool.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: cachedTool.lastAssistantMessageIsToolOutput
  })
  if (!payload) {
    return null
  }
  // Why the override: a child's wait must surface even when its provider never named which child is
  // waiting, so there is no roster row to carry the state.
  return resolvePaneHold(
    payload,
    effectiveLeadState,
    children,
    facts.kind === 'child' && facts.waiting === true,
    { previousMainAgent: state.lastStatusByPaneKey.get(paneKey)?.payload.mainAgent, now }
  )
}

/** Drop the row this lane published from a live child set, once nothing is left to justify it:
 *  the cached row is the last survivor of a hold whose child is gone. Only a row carrying
 *  descendants is this lane's own — a pane nobody has described has no row, and a row from before
 *  a scope reset carries no child to retract. */
function retractDescendantHoldRow(state: HookListenerState, paneKey: string): void {
  if ((state.lastStatusByPaneKey.get(paneKey)?.payload.subagents?.length ?? 0) > 0) {
    deleteLegacyAgentStatus(state, paneKey)
  }
}

/** How long a retired child's conversation is still recognised. Long enough for a spooled hook
 *  written before the retirement to be replayed, short enough that it never catches a new run —
 *  a conversation id is never reused. */
const RETIRED_DESCENDANT_MEMORY_MS = 5 * 60_000

/** Remember the conversations of children about to leave the roster. */
function rememberRetiredDescendants(
  state: HookListenerState,
  paneKey: string,
  roster: AgentDescendantRoster,
  kept: ReadonlySet<string>,
  now: number
): void {
  for (const [id, tracked] of roster) {
    if (!kept.has(id)) {
      rememberRetiredDescendant(state, paneKey, tracked.providerSession, now)
    }
  }
}

/** Remember one child's conversation as retired, for the same short window as a roster departure. */
function rememberRetiredDescendant(
  state: HookListenerState,
  paneKey: string,
  providerSession: string | undefined,
  now: number
): void {
  if (!providerSession) {
    return
  }
  let byConversation = state.retiredPiClaudeChildrenByPaneKey.get(paneKey)
  if (!byConversation) {
    byConversation = new Map()
    state.retiredPiClaudeChildrenByPaneKey.set(paneKey, byConversation)
  }
  byConversation.set(providerSession, now)
  for (const [conversation, at] of byConversation) {
    if (now - at > RETIRED_DESCENDANT_MEMORY_MS) {
      byConversation.delete(conversation)
    }
  }
}

export function isRetiredPiClaudeChild(
  state: HookListenerState,
  paneKey: string,
  providerSession: string | undefined
): boolean {
  const conversation = providerSession?.trim()
  if (!conversation) {
    return false
  }
  const retired = state.retiredPiClaudeChildrenByPaneKey.get(paneKey)?.get(conversation)
  return retired !== undefined && Date.now() - retired <= RETIRED_DESCENDANT_MEMORY_MS
}

export function applyDescendantLiveSet(
  state: HookListenerState,
  paneKey: string,
  children: readonly DescendantEntry[],
  now = Date.now()
): void {
  const roster = getOrCreateDescendantRoster(state, paneKey)
  rememberRetiredDescendants(state, paneKey, roster, new Set(children.map((c) => c.id)), now)
  replaceAgentDescendants(roster, children, now)
  dropEmptyDescendantRoster(state, paneKey, now)
}

/** The pane is idle only when its lead session is idle AND no descendant is live.
 *  Records the lead's own verdict first, so draining the last descendant later
 *  republishes what the lead actually said instead of the gated value.
 *
 *  `restated` marks a payload that republishes a row rather than report a verdict. Its state is
 *  derived (by `pi-family-events.ts` `restatedLeadFields`) from the record this gate keeps, so
 *  recording it back would let a value this lane synthesised — `applyDescendantEventToPane`'s
 *  `leadState ?? 'working'` — become the verdict, and the drain that follows could never settle. */
export function gatePaneStateOnDescendants(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload | null,
  options: { restated?: boolean } = {}
): ParsedAgentStatusPayload | null {
  if (!payload) {
    return payload
  }
  const now = Date.now()
  // Why also a restated `done`: the fold only ever outputs `done` from a `done` lead, and a restated
  // `done` can only come from a settled row — so it is the lead's own verdict, and the one a host-side
  // settle (Ctrl-C) wrote into the cached row without touching this map. Every other restated state
  // may be a value this lane synthesised, and recording it would pin the row.
  if (options.restated !== true || payload.state === 'done') {
    state.descendantLeadStateByPaneKey.set(paneKey, payload.state)
  }
  // Why the payload's own list wins when it has one: a provider that reports its roster on every
  // post means an absent list is "no children", so carrying the last forward would resurrect one.
  rememberReportedChildren(state, paneKey, payload.subagents, now)
  dropEmptyDescendantRoster(state, paneKey, now)
  const children = paneChildSnapshots(state, paneKey, payload.subagents)
  // Why reference-identical: a pane with no children must publish exactly what its provider said.
  if (children.length === 0) {
    return payload
  }
  return resolvePaneHold(payload, payload.state, children, false, {
    previousMainAgent: state.lastStatusByPaneKey.get(paneKey)?.payload.mainAgent,
    now
  })
}

/** Whether a child this lane knows about is blocked on a human answer. Only the narrow grok reader
 *  records one for a provider that owns its own roster, and that wait is the one state the owning
 *  lane cannot answer for: `providers/grok-events.ts` drops every payload naming a child, so
 *  without this the row would settle `done` over a question nobody has answered. */
export function paneHasWaitingDescendant(state: HookListenerState, paneKey: string): boolean {
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    return false
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'waiting') {
      return true
    }
  }
  return false
}

/** Reap children nothing has mentioned for the quiet window, then forget a roster with
 *  nothing left in it — the pane must not keep a claim it can no longer justify. */
function dropEmptyDescendantRoster(state: HookListenerState, paneKey: string, now: number): void {
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    return
  }
  // Why remember first: the reaper's own departures are the ones no post will ever mention again,
  // and a child's process outliving its row is exactly what the retired window covers.
  for (const tracked of roster.values()) {
    rememberRetiredDescendant(state, paneKey, tracked.providerSession, now)
  }
  pruneStaleAgentDescendants(roster, now)
  if (roster.size === 0) {
    state.descendantRosterByPaneKey.delete(paneKey)
  }
}

export function clearDescendantScope(state: HookListenerState, paneKey: string): void {
  state.descendantRosterByPaneKey.delete(paneKey)
  state.reportedSubagentsByPaneKey.delete(paneKey)
  state.descendantLeadStateByPaneKey.delete(paneKey)
}
