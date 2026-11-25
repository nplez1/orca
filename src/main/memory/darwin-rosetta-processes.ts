import { runProcess } from '@orca/process-host'
import { getLocalDaemonPid } from './local-daemon-pid'
import { collectSubtree, type ProcIndex } from './process-index'
import type { MemorySnapshot, RosettaProcess } from '../../shared/diagnostics/process-stats-types'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-observation/process-output-field-scanner'

// <sys/proc.h> P_TRANSLATED: Rosetta runs the process as x86_64 (Activity Monitor's "Kind: Intel").
const P_TRANSLATED = 0x00020000
// Rosetta processes that trigger macOS's Intel-app warning live for minutes, so the 2 s poll can reuse a sweep.
const SWEEP_REFRESH_MS = 10_000
const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 4 * 1024 * 1024

let cache: { sweptAt: number; pids: readonly number[] } | null = null

/** Pids whose `ps -o pid=,flags=` row carries P_TRANSLATED. */
export function parseTranslatedPids(stdout: string): number[] {
  const pids: number[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const [pid, flags] = getProcessOutputFields(line, 2)
    const parsedPid = Number.parseInt(pid ?? '', 10)
    const parsedFlags = Number.parseInt(flags ?? '', 16)
    if (Number.isInteger(parsedPid) && (parsedFlags & P_TRANSLATED) !== 0) {
      pids.push(parsedPid)
    }
  }
  return pids
}

async function runPs(args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args,
      maxOutputBytes: PS_MAX_BUFFER,
      timeoutMs: PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    return result.timedOut || result.outputTruncated || result.code !== 0 ? null : result.stdout
  } catch {
    return null
  }
}

async function translatedPids(now: number): Promise<readonly number[]> {
  if (cache && now - cache.sweptAt < SWEEP_REFRESH_MS) {
    return cache.pids
  }
  const stdout = await runPs(['-axo', 'pid=,flags='])
  cache = { sweptAt: now, pids: stdout === null ? [] : parseTranslatedPids(stdout) }
  return cache.pids
}

/** Processes in `isOrcaPid`'s tree that run under Rosetta, with their executable; macOS only. */
export async function readDarwinRosettaProcesses(
  isOrcaPid: (pid: number) => boolean,
  now = Date.now()
): Promise<RosettaProcess[]> {
  if (process.platform !== 'darwin') {
    return []
  }
  const pids = (await translatedPids(now)).filter(isOrcaPid)
  if (pids.length === 0) {
    return []
  }
  // Only for the offenders: comm= is the exec path, which the user needs to route the fix.
  const stdout = await runPs(['-o', 'pid=,comm=', '-p', pids.join(',')])
  const processes: RosettaProcess[] = []
  for (const line of iterateProcessOutputLines(stdout ?? '')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match) {
      processes.push({ pid: Number.parseInt(match[1], 10), executable: match[2].trim() })
    }
  }
  return processes
}

/** Rosetta processes in Electron's tree, the detached terminal daemon's, or any claimed terminal or agent tree. */
export async function readRosettaSnapshotFields(
  processIndex: ProcIndex,
  claimed: ReadonlySet<number>
): Promise<Pick<MemorySnapshot, 'rosettaProcesses'>> {
  const daemonPid = getLocalDaemonPid()
  const appTree = new Set([
    ...collectSubtree(processIndex, process.pid),
    ...(daemonPid === null ? [] : collectSubtree(processIndex, daemonPid))
  ])
  const rosettaProcesses = await readDarwinRosettaProcesses(
    (pid) => claimed.has(pid) || appTree.has(pid)
  )
  return rosettaProcesses.length > 0 ? { rosettaProcesses } : {}
}
