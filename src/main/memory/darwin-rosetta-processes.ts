import { runProcess } from '@orca/process-host'
import { getLocalDaemonPid } from './local-daemon-pid'
import { collectSubtree, isTranslatedPsFlags, type ProcIndex } from './process-index'
import type { MemorySnapshot, RosettaProcess } from '../../shared/diagnostics/process-stats-types'
import { iterateProcessOutputLines } from '../../shared/process-observation/process-output-field-scanner'

const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 1024 * 1024

/** `ps -o pid=,flags=,comm=` rows still under Rosetta; re-checked because a pid may be reused since the sweep. */
export function parseRosettaProcesses(stdout: string): RosettaProcess[] {
  const processes: RosettaProcess[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (match && isTranslatedPsFlags(match[2])) {
      processes.push({ pid: Number.parseInt(match[1], 10), executable: match[3].trim() })
    }
  }
  return processes
}

async function readExecutables(pids: readonly number[]): Promise<RosettaProcess[]> {
  try {
    // comm= is the executed path the user needs to route the fix; asked only for the offenders.
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,flags=,comm=', '-p', pids.join(',')],
      maxOutputBytes: PS_MAX_BUFFER,
      timeoutMs: PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    return result.timedOut || result.outputTruncated ? [] : parseRosettaProcesses(result.stdout)
  } catch {
    return []
  }
}

/** Rosetta processes in Electron's tree, the detached terminal daemon's, or any claimed terminal or agent tree. */
export async function readRosettaSnapshotFields(
  processIndex: ProcIndex,
  claimed: ReadonlySet<number>
): Promise<Pick<MemorySnapshot, 'rosettaProcesses'>> {
  if (process.platform !== 'darwin') {
    return {}
  }
  const translated = [...processIndex.byPid.values()].filter((row) => row.translated)
  if (translated.length === 0) {
    return {}
  }
  const daemonPid = getLocalDaemonPid()
  const appTree = new Set([
    ...collectSubtree(processIndex, process.pid),
    ...(daemonPid === null ? [] : collectSubtree(processIndex, daemonPid))
  ])
  const pids = translated
    .map((row) => row.pid)
    .filter((pid) => claimed.has(pid) || appTree.has(pid))
  const rosettaProcesses = pids.length === 0 ? [] : await readExecutables(pids)
  return rosettaProcesses.length > 0 ? { rosettaProcesses } : {}
}
