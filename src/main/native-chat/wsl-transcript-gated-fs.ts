import type { Dirent, Stats } from 'node:fs'
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/file-content/node-bounded-file-reader'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { isWslUncPath } from '../../shared/wsl-paths'
import { runWslTranscriptFsTask, type WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import { runWslTranscriptFsProcess } from './wsl-transcript-fs-process-dispatch'
import type { WslTranscriptFsReusableProcessCall } from './wsl-transcript-fs-process-protocol'
import { wslTranscriptFsLaneKey } from './wsl-transcript-fs-route'
import { admitWslTranscriptPath } from './wsl-transcript-running-admission'
import { statSshTranscript } from './ssh-transcript-fs-access'
import { parseSshTranscriptPath } from './ssh-transcript-path'

export type TranscriptFileStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino'>

// One request defines both route/dedup identity and child operation, preventing mismatches.
function runReusableFsOperation<T>(
  request: WslTranscriptFsReusableProcessCall,
  priority: WslTranscriptFsTaskPriority,
  signal: AbortSignal | undefined,
  localTask: () => Promise<T>
): Promise<T> {
  throwIfSignalAborted(signal)
  const pending = isWslUncPath(request.path)
    ? admitWslTranscriptPath(request.path).then(() =>
        runWslTranscriptFsTask(
          { operation: request.operation, path: request.path, priority, signal },
          async (taskSignal) => {
            // Queued work runs later: ask again right before the touch.
            await waitForPromiseWithSignal(admitWslTranscriptPath(request.path), taskSignal)
            return runWslTranscriptFsProcess<T>(
              request,
              taskSignal,
              wslTranscriptFsLaneKey(request.path, priority)
            )
          }
        )
      )
    : localTask()
  return waitForPromiseWithSignal(pending, signal)
}

export function wslGatedAccess(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<boolean> {
  return runReusableFsOperation({ operation: 'access', path }, priority, signal, async () => {
    await access(path)
    return true
  })
}

export function wslGatedStat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runReusableFsOperation({ operation: 'stat', path }, priority, signal, () => stat(path))
}

export function transcriptFileStat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<TranscriptFileStats> {
  const ssh = parseSshTranscriptPath(path)
  return ssh
    ? waitForPromiseWithSignal(statSshTranscript(ssh), signal)
    : wslGatedStat(path, priority, signal)
}

export function wslGatedLstat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runReusableFsOperation({ operation: 'lstat', path }, priority, signal, () => lstat(path))
}

export function wslGatedReaddir(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Dirent[]> {
  return runReusableFsOperation({ operation: 'readdir', path }, priority, signal, () =>
    readdir(path, { withFileTypes: true })
  )
}

/**
 * Whole-file ceiling for the JSON parsers, in the scanner child's 384 MB heap.
 *
 * Why 16 MB: `readFile` + `JSON.parse` holds the source string and a decoded object graph at
 * roughly four times the file size, so a few concurrent 16 MB parses still fit; an unbounded read of
 * a 200 MB summary file with inline images does not, and the scanner has no per-file guard.
 */
export const TRANSCRIPT_WHOLE_FILE_READ_MAX_BYTES = 16 * 1024 * 1024

export async function wslGatedReadFile(
  path: string,
  encoding: BufferEncoding,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal,
  maxBytes: number = TRANSCRIPT_WHOLE_FILE_READ_MAX_BYTES
): Promise<string> {
  if (!isWslUncPath(path) && !parseSshTranscriptPath(path)) {
    const read = await readNodeFileWithinLimit(path, maxBytes, { signal })
    return read.buffer.toString(encoding)
  }
  // A remote read materializes its own text, so the size has to be known before it starts. The
  // probe is best-effort: a path whose stat fails still gets its read, whose error is the one worth
  // reporting (a missing transcript is not an oversized one).
  const probed = await transcriptFileStat(path, priority, signal).catch(() => null)
  if (probed && probed.size > maxBytes) {
    throw new NodeFileReadTooLargeError(probed.size, maxBytes)
  }
  const text = await runReusableFsOperation(
    { operation: 'readfile', path, encoding },
    priority,
    signal,
    () => readFile(path, encoding)
  )
  // ...and again after: the probe can be stale, and the parsers all ask for utf-8.
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes > maxBytes) {
    throw new NodeFileReadTooLargeError(bytes, maxBytes)
  }
  return text
}
