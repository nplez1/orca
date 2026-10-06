import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** The one line a pi handler uses to hand the child lane the session its own event context named —
 *  the only thing that decides which session a child reported on that handler's bus belongs to. */
export function getPiAgentStatusAsyncSubagentSessionNoteLines(kind: PiAgentKind): string[] {
  return kind === 'pi' ? ['    piAsyncSubagentNoteSession(ctx, piAsyncSubagentRegistration)'] : []
}

/** Async child runs delegated to the subagent extension outlive the parent turn: the parent
 *  settles and goes interactive while the children keep working, and the parent's own
 *  `agent_end` is still the parent's. Their lifecycle rides pi's extension event bus rather
 *  than the extension API, so it is forwarded here and folded into the pane's descendant
 *  roster receiver-side.
 *
 *  Two plugin lineages are bound because their channel names differ, and a channel nothing
 *  emits on is simply never fired:
 *  - `pi-subagents` (tintinweb, the local fork) — `subagents:created` / `:started` add a child,
 *    `:completed` / `:failed` retire it. Documented in its README as emitted via `pi.events`.
 *  - `@earendil-works/pi-subagents` — `subagent:async-started` / `subagent:async-complete`
 *    retire a child; `subagent:process-terminal` retires one whose runner exited without ever
 *    emitting a completion of its own.
 *  Neither plugin emits any of these on `process`, so nothing is bound there.
 *
 *  Posts the FULL live set rather than a start/complete delta. `post` in the extension transport
 *  is a latest-only single slot: while a delivery is in flight, a newer post overwrites the
 *  pending one and the overwritten message is never sent. Every other caller posts a complete
 *  snapshot, so a dropped one is harmless. A dropped delta is not — a lost completion would
 *  strand a finished child in the roster and pin the pane 'working' with nothing left to clear
 *  it. Sending the whole set keeps this caller idempotent like the rest: the newest message is
 *  complete, so it repairs whatever the coalescer dropped before it.
 *
 *  Channel binding stays once per evaluation — one binding per channel, with a session boundary
 *  resetting the flag because Pi hands the re-run factory a fresh `pi.events` — while the
 *  REGISTRATION that decides a child's session is per factory run. That split is what keeps two
 *  registrations out of each other's buckets and stops one registration's shutdown from refusing
 *  the other's bus; a second factory in ONE evaluation shares the single armed channel by policy. */
export function getPiAgentStatusAsyncSubagentSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  // Why: pi reloads extensions in-process and re-runs this factory: pi.on handlers are',
    '  // replaced, but bus listeners can outlive the registration that bound them, so bind at most',
    '  // once per evaluation. Deliberately a BLOCK and not an early return — returning would skip',
    '  // every handler registered after this point.',
    '  // Why: a registration per factory run, holding only what THIS run may say: which session its',
    '  // own event context named, and whether its own shutdown has superseded it. Deliberately not a',
    '  // process-global token — a registration’s shutdown must refuse its own bus and nothing else.',
    '  const piAsyncSubagentRegistration: PiAsyncSubagentRegistration = { sessionKey: null, closed: false }',
    '  piAsyncSubagentActiveRegistration = piAsyncSubagentRegistration',
    '  if (!piAsyncSubagentBusBound) {',
    '  try {',
    '    const bus = pi && typeof pi === "object" ? (pi as { events?: { on?: (event: string, listener: (payload: unknown) => void) => void } }).events : undefined',
    '    const isSuperseded = (): boolean => piAsyncSubagentRegistration.closed',
    '    const readBusField = (payload: unknown, keys: string[]): string | undefined => {',
    "      if (!payload || typeof payload !== 'object') return undefined",
    '      const record = payload as Record<string, unknown>',
    '      for (const key of keys) {',
    '        const value = record[key]',
    "        if (typeof value === 'string' && value) return value",
    '      }',
    '      return undefined',
    '    }',
    '    // Why: both lineages key a child by its own id; the rest are their older aliases.',
    '    const readRunId = (payload: unknown): string | undefined =>',
    "      readBusField(payload, ['id', 'runId', 'run_id', 'subagentId', 'subagent_id'])",
    '    const postAsyncSubagentState = (): void => {',
    '      if (isOmpRuntime()) return',
    '      // Why: the receiver REPLACES its child list with this post’s set, and the set itself rides',
    '      // every post, so a post that loses the race with a newer one costs nothing.',
    "      post('subagent_async_state')",
    '    }',
    '    const onAsyncStarted = (payload: unknown): void => {',
    '      if (isSuperseded()) return',
    '      const runId = readRunId(payload)',
    '      // Why: an unnamed child could never be removed again, so it must not be added.',
    '      if (!runId) return',
    '      piAsyncSubagentRunsForWrite(piAsyncSubagentRegistration).set(runId, {',
    '        id: runId,',
    "        agent_type: readBusField(payload, ['agentType', 'agent_type', 'subagentType', 'type']),",
    "        description: readBusField(payload, ['description', 'task', 'prompt']),",
    '        // Why: a workflow’s completion is the only end signal its awaited children get once a',
    '        // /reload has dropped theirs, so the parent link has to survive with the run.',
    "        parent: readBusField(payload, ['parentWorkflowRunId', 'parent_workflow_run_id', 'parent']),",
    '        registration: piAsyncSubagentRegistration',
    '      })',
    '      postAsyncSubagentState()',
    '    }',
    '    const onAsyncComplete = (payload: unknown): void => {',
    '      if (isSuperseded()) return',
    '      const runId = readRunId(payload)',
    '      if (!runId || !piAsyncSubagentRetireRun(piAsyncSubagentRegistration, runId)) return',
    '      postAsyncSubagentState()',
    '    }',
    "    for (const channel of ['subagents:created', 'subagents:started', 'subagent:async-started']) {",
    '      bus?.on?.(channel, onAsyncStarted)',
    '    }',
    '    // Why: a child whose only end signal is its runner exit (`subagent:process-terminal`) would',
    '    // otherwise stay in the live set until the descendant lane quiet-reaped it. That event names',
    "    // the run as `runId` — one of readRunId's aliases — and only shrinks the posted set: the pane",
    '    // recomputes its own hold from that set rather than settling on the event.',
    "    for (const channel of ['subagents:completed', 'subagents:failed', 'subagent:async-complete', 'subagent:process-terminal']) {",
    '      bus?.on?.(channel, onAsyncComplete)',
    '    }',
    '    piAsyncSubagentBusBound = true',
    '  } catch {',
    '    // Why: status reporting must never fail the pi run; an unavailable bus just means no children.',
    '  }',
    '  }',
    ''
  ]
}
