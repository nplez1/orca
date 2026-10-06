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
 *  Channel binding is keyed by the BUS it belongs to — one binding per channel per `pi.events`
 *  object — while the REGISTRATION that decides a child's session is what those channels read at
 *  call time. Pi hands a re-run factory its own bus, so a bus this lane has not armed is a channel
 *  nothing observes and is armed; a bus already carrying this lane is never armed twice, and the
 *  newest registration on it takes over what those channels report. That split is what keeps two
 *  registrations out of each other's buckets, and stops one registration's shutdown from refusing
 *  the other's bus. */
export function getPiAgentStatusAsyncSubagentSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  // Why: pi reloads extensions in-process and re-runs this factory: pi.on handlers are',
    '  // replaced, but bus listeners can outlive the registration that bound them. Deliberately a',
    '  // BLOCK and not an early return — returning would skip every handler registered after this point.',
    '  // Why: a registration per factory run, holding only what THIS run may say: which session its',
    '  // own event context named, and whether its own shutdown has superseded it. Deliberately not a',
    '  // process-global token — a registration’s shutdown must refuse its own bus and nothing else.',
    '  const piAsyncSubagentRegistration: PiAsyncSubagentRegistration = { sessionKey: null, closed: false }',
    '  piAsyncSubagentActiveRegistration = piAsyncSubagentRegistration',
    '  // Why: the bus decides between arming and taking over. Arm a bus this lane does not hold yet,',
    '  // and adopt one it already holds: a re-run that Pi does not replace keeps the `pi.events` it',
    '  // was handed, so the binding belongs to the bus, and the run now live on it is what its',
    '  // channels report for.',
    '  const piAsyncSubagentBus = pi && typeof pi === "object" ? (pi as { events?: unknown }).events : undefined',
    '  const piAsyncSubagentExistingBinding = piAsyncSubagentBindingForBus(piAsyncSubagentBus)',
    '  if (piAsyncSubagentExistingBinding) {',
    '    piAsyncSubagentExistingBinding.registration = piAsyncSubagentRegistration',
    '  } else if (piAsyncSubagentBus && typeof (piAsyncSubagentBus as { on?: unknown }).on === "function") {',
    '  try {',
    '    const bus = piAsyncSubagentBus as { on: (event: string, listener: (payload: unknown) => void) => void; off?: (event: string, listener: (payload: unknown) => void) => void }',
    '    const binding: PiAsyncSubagentBusBinding = { bus, registration: piAsyncSubagentRegistration, listeners: [] }',
    '    piAsyncSubagentBusBindings.push(binding)',
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
    '    // Why: both callbacks read the BINDING, not this run: the registration a bus reports for can',
    '    // be replaced by a newer one, and a superseded registration must not keep filing children',
    '    // under the session it happened to name.',
    '    const onAsyncStarted = (payload: unknown): void => {',
    '      const registration = binding.registration',
    '      if (registration.closed) return',
    '      const runId = readRunId(payload)',
    '      // Why: an unnamed child could never be removed again, so it must not be added.',
    '      if (!runId) return',
    '      piAsyncSubagentRunsForWrite(registration).set(runId, {',
    '        id: runId,',
    "        agent_type: readBusField(payload, ['agentType', 'agent_type', 'subagentType', 'type']),",
    "        description: readBusField(payload, ['description', 'task', 'prompt']),",
    '        // Why: a workflow’s completion is the only end signal its awaited children get once a',
    '        // /reload has dropped theirs, so the parent link has to survive with the run.',
    "        parent: readBusField(payload, ['parentWorkflowRunId', 'parent_workflow_run_id', 'parent']),",
    '        registration',
    '      })',
    '      postAsyncSubagentState()',
    '    }',
    '    const onAsyncComplete = (payload: unknown): void => {',
    '      const registration = binding.registration',
    '      if (registration.closed) return',
    '      const runId = readRunId(payload)',
    '      if (!runId || !piAsyncSubagentRetireRun(registration, runId)) return',
    '      postAsyncSubagentState()',
    '    }',
    "    for (const channel of ['subagents:created', 'subagents:started', 'subagent:async-started']) {",
    '      bus.on(channel, onAsyncStarted)',
    '      binding.listeners.push({ channel, listener: onAsyncStarted })',
    '    }',
    '    // Why: a child whose only end signal is its runner exit (`subagent:process-terminal`) would',
    '    // otherwise stay in the live set until the descendant lane quiet-reaped it. That event names',
    "    // the run as `runId` — one of readRunId's aliases — and only shrinks the posted set: the pane",
    '    // recomputes its own hold from that set rather than settling on the event.',
    "    for (const channel of ['subagents:completed', 'subagents:failed', 'subagent:async-complete', 'subagent:process-terminal']) {",
    '      bus.on(channel, onAsyncComplete)',
    '      binding.listeners.push({ channel, listener: onAsyncComplete })',
    '    }',
    '  } catch {',
    '    // Why: status reporting must never fail the pi run; an unavailable bus just means no children.',
    '  }',
    '  }',
    ''
  ]
}
