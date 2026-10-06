import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Where the fork's pi child lane keeps its live set, and which session that set belongs to.
 *
 *  Pi hands a re-run factory a fresh `pi.events` and re-evaluates this module on /reload, so
 *  neither a module-scope map nor a bus object can hold a session's children: the first is rebuilt
 *  empty by the reload, the second dies with the session. `globalThis` outlives both, and the
 *  children are keyed by the session that owns them — a pane shows one session's children at a
 *  time, and a session that comes back gets its own back instead of having lost them. */
export function getPiAgentStatusAsyncSubagentSessionModuleLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    'type PiAsyncSubagentRun = { id: string; agent_type?: string; description?: string }',
    'type PiAsyncSubagentState = {',
    '  bySession: Map<string, Map<string, PiAsyncSubagentRun>>',
    // Why: only the registration that bound the current bus may write; a superseded one is refused.
    '  registration: object | null',
    '  lastSession: string | null',
    '}',
    'declare global { var __orcaPiAsyncSubagents: PiAsyncSubagentState | undefined }',
    'const piAsyncSubagentState: PiAsyncSubagentState = globalThis.__orcaPiAsyncSubagents ??= { bySession: new Map(), registration: null, lastSession: null }',
    // Why: bound at most once per evaluation. A session change resets it — Pi hands the re-run
    // factory a fresh `pi.events` — and a /reload re-evaluates this module, which resets it too.
    'let piAsyncSubagentBusBound = false',
    '',
    '// Why: the session file is what Pi names in a resume target and what a session is kept by, so it',
    '// is the identity a child belongs to; the id is the fallback when Pi has no file to name yet.',
    'function piAsyncSubagentSessionKey(): string {',
    '  const file = sessionMetadata.session_file',
    "  if (typeof file === 'string' && file) {",
    '    piAsyncSubagentState.lastSession = file',
    '    return file',
    '  }',
    '  const id = sessionMetadata.session_id',
    "  if (typeof id === 'string' && id) {",
    '    piAsyncSubagentState.lastSession = id',
    '    return id',
    '  }',
    '  // Why: a /reload re-evaluates this module, so its `sessionMetadata` is empty until the resumed',
    "  // session's own `session_start`; a child that reports in that window is still that session's.",
    "  return piAsyncSubagentState.lastSession ?? ''",
    '}',
    '',
    '// Why: resolved per use rather than cached: the metadata names the session the event ran in.',
    'function piAsyncSubagentRuns(): Map<string, PiAsyncSubagentRun> {',
    '  const key = piAsyncSubagentSessionKey()',
    '  let runs = piAsyncSubagentState.bySession.get(key)',
    '  if (!runs) {',
    '    runs = new Map()',
    '    piAsyncSubagentState.bySession.set(key, runs)',
    '  }',
    '  return runs',
    '}',
    '',
    "// Why: the child set is pane STATE, not an event, and pi's transport keeps only the newest post —",
    '// the add a background spawn emits is overwritten by the tool burst that ends that same spawn.',
    '// Riding every post means whichever post survives carries the truth for the session on screen.',
    'function piAsyncSubagentField(): Record<string, unknown> {',
    '  if (!piAsyncSubagentBusBound || isOmpRuntime()) return {}',
    '  return { subagent_runs: Array.from(piAsyncSubagentRuns().values()) }',
    '}',
    ''
  ]
}
