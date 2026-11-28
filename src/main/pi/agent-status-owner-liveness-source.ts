/** The one owner-claim probe both pi extensions run.
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
 *  main/agent-hooks/managed-hook-owner-identity.ts.
 *
 *  Why a pane record beside the PID (#480): `process.env` reaches the whole descendant tree, so a
 *  marker naming a live PID cannot tell the nested subagent this lock exists for (#8545) from a
 *  process reporting for a different pane, and standing down for that one mutes a working pane for
 *  as long as the owner lives. Each claim therefore records the claimant's `ORCA_PANE_KEY`, and a
 *  marker inherited from another pane is no claim on this one.
 *
 *  A same-pane descendant still stands down: two reporters on one pane is the false-completion
 *  failure #8545 exists to prevent, and the child cannot see an owner that outlives its turn. What
 *  changes is that the stand-down is no longer silent — it is recorded on `globalThis` and warned
 *  once when the process owns a TTY or sets `ORCA_PI_STATUS_DEBUG`, which is the difference between
 *  "the pane is idle" and "this session muted itself". */
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
    '',
    '// The lane owner key records its claimant; `<key>_PANE` records which pane that claim covered.',
    'function yieldsPaneOwnership(ownerKey: string): boolean {',
    '  const ownerPid = process.env[ownerKey]',
    '  if (!ownerPid || ownerPid === String(process.pid)) return false',
    '  const ownerPane = process.env[ownerKey + "_PANE"]',
    '  const paneKey = process.env.ORCA_PANE_KEY',
    '  // A missing record is an older writer: read it as this pane, never as a free one.',
    '  if (ownerPane && paneKey && ownerPane !== paneKey) return false',
    '  return isStatusOwnerAlive(ownerPid)',
    '}',
    '',
    '// Why claim both: a PID without its pane would let a later reader pair a new owner with a stale pane.',
    'function claimPaneOwnership(ownerKey: string): void {',
    '  process.env[ownerKey] = String(process.pid)',
    '  const paneKey = process.env.ORCA_PANE_KEY',
    '  if (paneKey) process.env[ownerKey + "_PANE"] = paneKey',
    '  else delete process.env[ownerKey + "_PANE"]',
    '}',
    '',
    '// Why a record at all: a stand-down is otherwise invisible — the pane reads idle while pi works (#480).',
    "const PANE_OWNER_STAND_DOWN = Symbol.for('orca.pi.pane-owner.stand-down')",
    '',
    'function notePaneOwnerStandDown(ownerKey: string): void {',
    '  const ownerPid = process.env[ownerKey] || ""',
    '  let recorded = Reflect.get(globalThis, PANE_OWNER_STAND_DOWN)',
    '  if (!(recorded instanceof Map)) {',
    '    recorded = new Map()',
    '    Reflect.set(globalThis, PANE_OWNER_STAND_DOWN, recorded)',
    '  }',
    '  // A reload, /new or /fork re-runs the factory; the record and its one line are per process.',
    '  if (recorded.has(ownerKey)) return',
    '  recorded.set(ownerKey, {',
    '    ownerPid,',
    '    ownerPane: process.env[ownerKey + "_PANE"] || null,',
    '    selfPid: String(process.pid),',
    '    paneKey: process.env.ORCA_PANE_KEY || null,',
    '    reason: "pane-reported-by-live-owner"',
    '  })',
    '  try {',
    '    // Only a TTY or an explicit opt-in has somewhere to read it; a piped subagent stays quiet.',
    '    const stderr = (process as { stderr?: { isTTY?: boolean } }).stderr',
    '    if (!stderr?.isTTY && !process.env.ORCA_PI_STATUS_DEBUG) return',
    '    const pane = process.env.ORCA_PANE_KEY || "?"',
    '    console.warn("[orca-pi-status] pane " + pane + " is reported by live pid " + ownerPid + "; this session reports no status, and clearing " + ownerKey + " would give this pane two reporters")',
    '  } catch {',
    '    // A warning must never be what stops a session from loading.',
    '  }',
    '}',
    ''
  ]
}
