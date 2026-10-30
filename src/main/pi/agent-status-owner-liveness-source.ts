/** The one owner-liveness probe both pi extensions run.
 *
 *  Why shared source lines: the status lane (`ORCA_PI_STATUS_OWNED`) and the titlebar lane
 *  (`ORCA_PI_TITLE_MARKER_OWNED`) decide "may I report for this pane?" from the same inherited env,
 *  and a restarted agent inherits the previous owner's PID. The status lane defended against a dead
 *  owner from the start; the titlebar lane did not, and a pane whose marker never painted also lost
 *  the ask-card lane that gates on it (#229). Generating both from this file keeps them from
 *  drifting again — neither can import Orca code, since they load inside pi/omp.
 *
 *  Only ESRCH proves the owner is gone: every other probe result keeps suppression, so a live
 *  foreign owner still cannot double-report. The tri-state mirrors
 *  main/agent-hooks/managed-hook-owner-identity.ts. */
export function getPiOwnerLivenessSourceLines(): string[] {
  return [
    '// Reclaim inherited dead owner PIDs only on ESRCH; all other probe results must suppress duplicate reporting.',
    'function isStatusOwnerAlive(pid: string): boolean {',
    '  const parsed = Number(pid)',
    '  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 0x7fffffff) return false',
    "  if (typeof process.kill !== 'function') return true",
    '  try {',
    '    process.kill(parsed, 0)',
    '    return true',
    '  } catch (err: unknown) {',
    "    return (err as { code?: string } | null)?.code !== 'ESRCH'",
    '  }',
    '}',
    ''
  ]
}
