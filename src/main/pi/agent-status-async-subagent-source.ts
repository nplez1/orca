import type { PiAgentKind } from '../../shared/pi-agent-kind'

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
 *  - `@earendil-works/pi-subagents` — `subagent:async-started` / `subagent:async-complete`.
 *  Neither plugin emits any of these on `process`, so nothing is bound there.
 *
 *  Posts the FULL live set rather than a start/complete delta. `post` in the extension transport
 *  is a latest-only single slot: while a delivery is in flight, a newer post overwrites the
 *  pending one and the overwritten message is never sent. Every other caller posts a complete
 *  snapshot, so a dropped one is harmless. A dropped delta is not — a lost completion would
 *  strand a finished child in the roster and pin the pane 'working' with nothing left to clear
 *  it. Sending the whole set keeps this caller idempotent like the rest: the newest message is
 *  complete, so it repairs whatever the coalescer dropped before it. */
export function getPiAgentStatusAsyncSubagentSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  // Why: pi reloads extensions in-process and re-runs this factory: pi.on handlers are',
    '  // replaced, but bus listeners accumulate, so bind at most once. Deliberately a BLOCK and',
    '  // not an early return — returning would skip every handler registered after this point.',
    '  if (!piAsyncSubagentBusBound) {',
    '  try {',
    '    const bus = pi && typeof pi === "object" ? (pi as { events?: { on?: (event: string, listener: (payload: unknown) => void) => void } }).events : undefined',
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
    '      // Why: the receiver REPLACES its child list with this array, so a post that loses the',
    '      // race with a newer one costs nothing — the newer one already carries the whole truth.',
    "      post('subagent_async_state', {",
    '        subagent_runs: Array.from(piAsyncSubagentRuns.values()),',
    '      })',
    '    }',
    '    const onAsyncStarted = (payload: unknown): void => {',
    '      const runId = readRunId(payload)',
    '      // Why: an unnamed child could never be removed again, so it must not be added.',
    '      if (!runId) return',
    '      piAsyncSubagentRuns.set(runId, {',
    '        id: runId,',
    "        agent_type: readBusField(payload, ['agentType', 'agent_type', 'subagentType', 'type']),",
    "        description: readBusField(payload, ['description', 'task', 'prompt']),",
    '      })',
    '      postAsyncSubagentState()',
    '    }',
    '    const onAsyncComplete = (payload: unknown): void => {',
    '      const runId = readRunId(payload)',
    '      if (!runId || !piAsyncSubagentRuns.delete(runId)) return',
    '      postAsyncSubagentState()',
    '    }',
    "    for (const channel of ['subagents:created', 'subagents:started', 'subagent:async-started']) {",
    '      bus?.on?.(channel, onAsyncStarted)',
    '    }',
    "    for (const channel of ['subagents:completed', 'subagents:failed', 'subagent:async-complete']) {",
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
