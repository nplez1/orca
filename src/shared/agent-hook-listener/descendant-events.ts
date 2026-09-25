import type { AgentHookSource } from '../agent-hook-relay'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import { readFirstString } from './interactive-tool'
import { isGrokEvent, normalizeHookEventName } from './provider-event-names'
import { readString } from './tool-input-preview'

/** Narrow one entry of a provider's child array where a cast would otherwise be needed. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One live descendant as its provider names it. */
export type DescendantEntry = {
  id: string
  agentType?: string
  description?: string
  model?: string
}

/** What one hook event says about the DESCENDANTS of the pane's lead session.
 *
 *  A descendant's lifecycle is not the pane's: it may change the child list, and it
 *  may never settle the pane or fire completion.
 *
 *  `child` is a delta from a provider whose child events each arrive as their own HTTP
 *  post, so none can be lost in transit. Its `id` is optional because some providers
 *  only mark an event as "this fired inside a child" without naming which one — still
 *  enough to refuse the settle. No provider emits it today: grok was the last user, and
 *  its own lane (providers/grok-events.ts) owns that ground now.
 *
 *  `live-set` is the authoritative full set, for a provider whose transport can drop an
 *  intermediate message. Applying a delta over a lossy transport is unrecoverable — a
 *  lost removal strands a finished child and pins the pane 'working' with nothing left
 *  to clear it — whereas replacing the set makes every message self-sufficient, so the
 *  newest one repairs whatever was dropped before it. */
export type DescendantEventFacts =
  | ({
      kind: 'child'
      ended: boolean
      /** The child is blocked on a human answer. A descendant's wait is the pane's actionable
       *  state, so it surfaces even when the provider never names which child is waiting. */
      waiting?: boolean
    } & Partial<DescendantEntry>)
  | { kind: 'live-set'; children: readonly DescendantEntry[] }

/** How one provider reports its descendants. Both questions live together on purpose: a
 *  provider that opts into descendants MUST also answer how the pane recovers when a
 *  child's finish never arrives, or it silently inherits "no recovery". */
type DescendantProviderAdapter = {
  readEvent: (
    eventName: unknown,
    hookPayload: Record<string, unknown>
  ) => DescendantEventFacts | null
  /** An event proving the descendants tracked so far can no longer be alive — the pane's
   *  agent process was replaced, or the turn that owns them was torn down. */
  isScopeReset: (eventName: unknown, hookPayload: Record<string, unknown>) => boolean
}

function readPiDescendantEvent(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  if (normalizeHookEventName(eventName) !== 'subagent_async_state') {
    return null
  }
  const children = readPiDescendantLiveSet(hookPayload)
  return children ? { kind: 'live-set', children } : null
}

/** The live child set a pi pane rides on EVERY post, not only the dedicated event. pi's
 *  transport keeps one latest-only slot, so the add a background spawn emits is routinely
 *  overwritten before delivery by the tool burst that ends that same spawn — reading the field
 *  off whichever event does arrive is what repairs the swallowed one. */
export function readPiDescendantLiveSetField(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>
): readonly DescendantEntry[] | null {
  return source === 'pi' ? readPiDescendantLiveSet(hookPayload) : null
}

function readPiDescendantLiveSet(hookPayload: Record<string, unknown>): DescendantEntry[] | null {
  const runs = hookPayload['subagent_runs']
  if (!Array.isArray(runs)) {
    return null
  }
  const children: DescendantEntry[] = []
  for (const run of runs) {
    if (!isRecord(run)) {
      continue
    }
    const id = readFirstString(run, ['id', 'run_id', 'runId', 'subagent_id'])
    if (id) {
      children.push({
        id,
        agentType: readFirstString(run, ['agent_type', 'agentType']),
        description: readString(run, 'description'),
        model: readString(run, 'model')
      })
    }
  }
  return children
}

/** Every provider answers, or is explicitly `null` for "reports no child sessions on the
 *  parent's pane". A `Record` over the source union makes a new provider a compile error
 *  here, so descendant support and its recovery are decided together, in one place.
 *
 *  Claude, Codex and Muse are `null` because they own richer rosters of their own — Claude's
 *  carries teammate parking, `background_tasks` folding and restored-snapshot provenance; Codex's
 *  carries rollout reconciliation; Muse's carries its own child-session filter — and each already
 *  derives the pane from them. Grok owns its roster too (it refuses to settle the parent from a
 *  child event and reads a background subagent as `working`), but it keeps one narrow reader here
 *  for the child question it cannot carry. */
/** Grok's one child event its own lane cannot carry. Grok auto-allows `ask_user_question`, so a
 *  child blocked on a human answer announces it as a PreToolUse — and `providers/grok-events.ts`
 *  drops every payload carrying `subagentType`, which would hide the wait entirely. Only this event
 *  comes through here; a grok child's start, finish and cancel stay that lane's business. */
function readGrokChildQuestion(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  if (!isGrokEvent(eventName, 'pre_tool_use')) {
    return null
  }
  // Why: grok stamps `subagentType` on every event that can fire inside a child and omits it in the
  // main session, so its absence is what keeps the LEAD's own question on the path that carries
  // `toolName` and `interactivePrompt`.
  const subagentType = readFirstString(hookPayload, ['subagentType', 'subagent_type'])
  if (subagentType === undefined) {
    return null
  }
  if (!isAskUserQuestionTool(readFirstString(hookPayload, ['toolName', 'tool_name', 'name']))) {
    return null
  }
  return {
    kind: 'child',
    id: readFirstString(hookPayload, ['subagentId', 'subagent_id']),
    agentType: subagentType,
    ended: false,
    waiting: true
  }
}

const DESCENDANT_PROVIDERS: Record<AgentHookSource, DescendantProviderAdapter | null> = {
  claude: null,
  codex: null,
  muse: null,
  grok: {
    readEvent: readGrokChildQuestion,
    // Why: a grok wait is retracted by the lane's quiet window rather than by a scope reset — the
    // owning lane drops the child events that would name the end, so there is no reset to read.
    isScopeReset: () => false
  },
  pi: {
    readEvent: readPiDescendantEvent,
    isScopeReset: (eventName) => eventName === 'session_start'
  },
  // Why: omp and prime-agent share pi's normalizer but not its subagent extension, so they
  // report no children today; give one a reader here if that changes.
  omp: null,
  'prime-agent': null,
  gemini: null,
  antigravity: null,
  amp: null,
  opencode: null,
  opencode2: null,
  'mimo-code': null,
  cursor: null,
  droid: null,
  'command-code': null,
  copilot: null,
  hermes: null,
  devin: null,
  kimi: null
}

/** Providers whose normalizer already tracks its own descendants and derives the pane state
 *  from them, so the generic path must not run a second, blinder copy over the same events. */
export function providerOwnsDescendantLifecycle(source: AgentHookSource): boolean {
  return source === 'claude' || source === 'codex' || source === 'muse' || source === 'grok'
}

export function readDescendantEventFacts(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  return DESCENDANT_PROVIDERS[source]?.readEvent(eventName, hookPayload) ?? null
}

export function isDescendantScopeResetEvent(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  return DESCENDANT_PROVIDERS[source]?.isScopeReset(eventName, hookPayload) === true
}
