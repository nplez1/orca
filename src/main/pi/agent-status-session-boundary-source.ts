import type { PiAgentKind } from '../../shared/pi-agent-kind'

// What the generated extension does when a session ends or is replaced. A run belongs to one
// session: once that session is gone its children never report here again, so the run ends with it.

// Pi replaces the registration for /new, resume and fork, and again for /reload, which keeps the session.
function getPiSessionShutdownHandlerSourceLines(): string[] {
  return [
    // Why: a registration's own cleanup cannot sit behind the ownership fence — a child
    // registration is refused the pane's status handlers, and refusing it here would leave its bus
    // armed and its runs in the holding map, which the pane then holds on forever. Nothing in this
    // handler reads or writes pane state: it closes exactly what this registration armed.
    "  pi.on('session_shutdown', (event) => {",
    '    const reason = (event as { reason?: unknown } | null)?.reason',
    '    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile',
    // Why: /reload and a resume of the file already open keep the session, and its children still report to it.
    "    const keepsSession = reason === 'reload' || (reason === 'resume' && typeof target === 'string' && target === sessionMetadata.session_file)",
    // Why: the registration that bound the old bus can still be called while Pi replaces it, so it
    // is refused from here on — and ONLY it. Another registration keeps its own, so no session’s
    // shutdown can silence another session’s bus.
    '    piAsyncSubagentRegistration.closed = true',
    // Why: close exactly the callbacks THIS registration armed. A superseded registration owns no
    // binding (the run now live on that bus took it over), so its shutdown leaves that bus reporting.
    '    piAsyncSubagentCloseBus(piAsyncSubagentRegistration)',
    // Why: on a reload or same-file resume this registration stops being called while its session
    // keeps running, so a child it reported before naming that session belongs to the kept one.
    // Otherwise its un-attributed children go with it: holding them would pin a pane nothing can clear.
    '    if (keepsSession) {',
    "      piAsyncSubagentAdoptHeldRuns(piAsyncSubagentRegistration, typeof sessionMetadata.session_file === 'string' ? sessionMetadata.session_file : null)",
    '    } else {',
    '      piAsyncSubagentDropHeldRuns(piAsyncSubagentRegistration)',
    '    }',
    '  })',
    '',
    "  onStatus('session_shutdown', (event) => {",
    '    clearPendingAgentEndCheck()',
    '    if (isOmpRuntime()) {',
    '      clearRunnerExitCheck()',
    '      resetPostQueue()',
    '      return',
    '    }',
    // Why: pi tears an open dialog down without resolving its promise, so no ui_prompt_end follows.
    '    piUiPromptDepth = 0',
    '    const reason = (event as { reason?: unknown } | null)?.reason',
    '    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile',
    // Why: /reload and a resume of the file already open keep the session, and its children still report to it.
    "    const keepsSession = reason === 'reload' || (reason === 'resume' && typeof target === 'string' && target === sessionMetadata.session_file)",
    '    if (!keepsSession) clearRunnerExitCheck()',
    // LOCAL(nplez1): Pi hands the factory it re-runs after this a FRESH `pi.events` for every
    // reload, resume and fork, so the next registration has to be allowed to arm that bus. Only
    // upstream's roster keys off the evaluation and is reset here; this lane's binding is keyed by
    // the bus it armed, and is closed with the registration that armed it (see the handler above).
    '    subagentChannelsBound = false',
    '    subagentRunnerExitBound = false',
    // Why: on quit the PTY's exit clears the pane, and a done here would notify on every quit.
    "    if (keepsSession || reason === 'quit') {",
    // Why: this registration's queue outlives it and would deliver stale posts after the next one's.
    '      resetPostQueue()',
    '      return',
    '    }',
    // Also a Pi too old to give a reason: its children would otherwise hold the pane for good.
    '    closeOutRun(sessionMetadata.session_file)',
    // Why: pi-subagents can still emit here until Pi invalidates this registration.
    '    lifecycleState.onEvent = undefined',
    '  })',
    ''
  ]
}

// Registered after onStatus exists; expects the roster and closeOutRun() from the handler scope.
export function getAgentStatusSessionBoundaryHandlerSourceLines(kind: PiAgentKind): string[] {
  return [
    ...(kind !== 'pi'
      ? [
          "  pi.on('session_shutdown', () => { resetSubagentRoster(); resetPostQueue(); clearPendingAgentEndCheck() })"
        ]
      : []),
    ...(kind !== 'prime-agent'
      ? [
          // Why: OMP keeps this registration and bus across a switch. /new and a branch cancel the
          // session's own jobs; fork and resume (which is also how it reloads) leave them running
          // and reporting here.
          '  const onOmpSessionChange = (event, ctx) => {',
          '    if (!isOmpRuntime()) return',
          "    if (event?.reason === 'fork' || event?.reason === 'resume') {",
          // Why: a resume cuts a running turn off without an agent_end.
          '      if (isTurnInFlight()) {',
          '        lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
          '        postAgentEndOnce()',
          '      }',
          '    } else {',
          '      closeOutRun()',
          '    }',
          '    updateRuntimeOmpSessionMetadata(ctx)',
          '  }',
          "  pi.on('session_switch', onOmpSessionChange)",
          "  pi.on('session_branch', onOmpSessionChange)"
        ]
      : []),
    ...(kind === 'pi' ? getPiSessionShutdownHandlerSourceLines() : [])
  ]
}

export function getAgentStatusRunCloseOutSourceLines(): string[] {
  return [
    // Why: pi-subagents re-attaches a resumed session's runs and reports their completion to it.
    '  function restoreParkedSubagents(): void {',
    '    const file = sessionMetadata.session_file',
    "    if (typeof file !== 'string') return",
    '    const parked = lifecycleState.parked?.get(file)',
    '    if (!parked) return',
    '    lifecycleState.parked?.delete(file)',
    '    for (const [id, detail] of parked) {',
    '      lifecycleState.active.add(id)',
    '      subagentDetails.set(id, detail)',
    '    }',
    '    if (!isHeldByChildren()) return',
    '    lifecycleState.waiting = true',
    '    lifecycleState.completionPostedGeneration = -1',
    '  }',
    '',
    // `parkUnder` keeps the children for a resume into that session file, where pi-subagents
    // announces each one's completion again.
    '  function closeOutRun(parkUnder?: unknown): void {',
    '    const unsettled = lifecycleState.waiting || isTurnInFlight()',
    "    if (typeof parkUnder === 'string' && isHeldByChildren()) {",
    '      const parked = new Map<string, SubagentDetail>()',
    '      for (const id of lifecycleState.active) {',
    '        const detail = subagentDetails.get(id)',
    '        if (detail && !lifecycleState.exited?.has(id)) parked.set(id, detail)',
    '      }',
    '      ;(lifecycleState.parked ??= new Map()).set(parkUnder, parked)',
    '    }',
    '    resetSubagentRoster()',
    '    resetPostQueue()',
    '    if (!unsettled) return',
    '    lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
    '    postAgentEndOnce(true)',
    '  }',
    ''
  ]
}

/** The host clears a working row only on a later completion, so a busy post that lands after the
 *  run already completed (a re-finalized message, a late tool end) must re-assert the completion
 *  it displaced — otherwise the pane reads working with no event left to answer it. */
export function getPiLateBusyPostCompletionSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  function republishLateBusyPostCompletion(): void {',
    '    if (piTurnInFlight) return',
    '    if (lifecycleState.runGeneration === 0) return',
    '    lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
    '    lifecycleState.completionPostedGeneration = -1',
    '    postAgentEndOnce()',
    '  }',
    ''
  ]
}
