import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Runs belong to sessions; after replacement their children can no longer report to this registration.

// Pi replaces registrations for session switches and reloads.
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
    '      // Why the whole session and not just the held runs: the final post this session emits',
    '      // still reports its live child set, and a host reading that set would refresh a run the',
    '      // ended session no longer owns instead of draining it.',
    '      piAsyncSubagentForgetSession(piAsyncSubagentRegistration)',
    '    }',
    '  })',
    '',
    "  onStatus('session_shutdown', (event) => {",
    '    clearPendingAgentEndCheck()',
    '    if (isOmpRuntime()) {',
    '      clearRunnerExitCheck()',
    '      resetPostQueue()',
    '      if (ownsPaneRoster) resetEndpointWatch()',
    '      return',
    '    }',
    // Pi can tear down dialogs without resolving their promises or sending close events.
    '    piUiPromptDepth = 0',
    '    const reason = (event as { reason?: unknown } | null)?.reason',
    '    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile',
    // Reload/current-file resume retains session ownership and future child reports.
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
    // This queue outlives registration and could otherwise deliver stale status after its replacement.
    '      resetPostQueue()',
    // Why: a session that keeps running (/reload, same-file resume) keeps watching; a quit does not,
    // and only the registration that owns the pane's roster speaks for the pane.
    "      if (reason === 'quit' && ownsPaneRoster) resetEndpointWatch()",
    '      return',
    '    }',
    // Older Pi lacks reasons; settle so orphaned children cannot hold the pane forever.
    '    closeOutRun(sessionMetadata.session_file)',
    '    // Why this post is not optional: `closeOutRun` only posts when the turn was unsettled, and a',
    '    // session ending from idle has nothing pending — so without this, the emptied live set would',
    '    // never reach the host, and the roster a host fences on would outlive the session. Enqueued',
    '    // here, after the reset, so it is delivered.',
    "    post('subagent_async_state')",
    // Why: pi-subagents can still emit here until Pi invalidates this registration.
    '    lifecycleState.onEvent = undefined',
    '  })',
    ''
  ]
}

export function getAgentStatusSessionBoundaryHandlerSourceLines(kind: PiAgentKind): string[] {
  return [
    ...(kind !== 'pi'
      ? [
          // Why the guard: an OMP task child registers this handler too, and the queue it would reset
          // describes the lead's pane — a child's shutdown is not the pane's.
          "  pi.on('session_shutdown', () => { resetSubagentRoster(); resetPostQueue(); if (ownsPaneRoster) resetEndpointWatch(); clearPendingAgentEndCheck() })"
        ]
      : []),
    ...(kind !== 'prime-agent'
      ? [
          // OMP preserves registration/bus: new/branch cancel jobs, fork/resume retain their reports.
          '  const onOmpSessionChange = (event, ctx) => {',
          '    if (!isOmpRuntime()) return',
          "    if (event?.reason === 'fork' || event?.reason === 'resume') {",
          // Resume can interrupt a turn without agent_end.
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
    // pi-subagents reattaches parked runs and repeats their completion after resume.
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
    // Park children under their session file for resumed completion delivery.
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
    '    if (ownsPaneRoster) resetEndpointWatch()',
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
