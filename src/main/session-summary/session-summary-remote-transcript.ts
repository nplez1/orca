// Brings a transcript file's bytes from an SSH host to this machine, so the existing
// AI Vault parsers decode it unchanged: they take a path, and a materialized copy is a
// path. Nothing about the fold runs on the SSH host — it cannot, since a plain SSH
// target runs only the relay CLI, with no Orca server to fold on.
//
// (A paired Orca server does not use this: it folds the session itself, in place.)
//
// Streamed rather than collected: `execCommand` keeps only the tail of its output
// (`MAX_EXEC_OUTPUT_CHARS`), which would silently drop the head of a large transcript
// and renumber every event the ledger's cursor counts.
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

/** The subset of an SSH exec channel this reader consumes. */
export type RemoteTranscriptChannel = Readable & { close(): void }

export type RemoteTranscriptFetch =
  /** A local copy ready to parse; `dispose` removes it. */
  | { kind: 'file'; path: string; dispose: () => Promise<void> }
  /** Above the cap: refused rather than silently truncated into a wrong cursor. */
  | { kind: 'too-large'; bytes: number }
  /** Nothing came back: no such file, or an empty one. */
  | { kind: 'missing' }

/**
 * 256 MB: past any transcript a person writes by hand, and the point where a session is measured in
 * days rather than hours.
 *
 * Why raised from 24 MB: the fold no longer refuses a large local transcript, so this bound is the
 * only thing that could still make an SSH-hosted session unfetchable — and it bounds a *copy*, not
 * what the fold retains. Streaming the remote file through the digest would remove the copy, but it
 * needs parser state at a byte offset on the far side, which is its own change.
 */
export const REMOTE_TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024
/**
 * Two deadlines, because one number cannot serve both cases: a stalled link and a slow one.
 *
 * The idle timer resets on every chunk, so a slow-but-moving transfer is never killed; the overall
 * ceiling is what stops a trickle that would otherwise hold the fold open forever.
 */
const REMOTE_TRANSCRIPT_IDLE_TIMEOUT_MS = 60_000
const REMOTE_TRANSCRIPT_TOTAL_TIMEOUT_MS = 15 * 60_000

export type SshTranscriptFetcherDeps = {
  /** Opens a shell command's channel on that SSH target; throws when it cannot. */
  openChannel: (args: {
    targetId: string
    command: string
    signal: AbortSignal
  }) => Promise<RemoteTranscriptChannel>
  tmpRoot?: string
  maxBytes?: number
  timeoutMs?: number
  /** Overall ceiling for one fetch; the idle timeout is derived from `timeoutMs`. */
  totalTimeoutMs?: number
}

export function createSshTranscriptFetcher(
  deps: SshTranscriptFetcherDeps
): (args: {
  targetId: string
  remotePath: string
  signal: AbortSignal
}) => Promise<RemoteTranscriptFetch> {
  const maxBytes = deps.maxBytes ?? REMOTE_TRANSCRIPT_MAX_BYTES
  const timeoutMs = deps.timeoutMs ?? REMOTE_TRANSCRIPT_IDLE_TIMEOUT_MS
  const totalTimeoutMs = deps.totalTimeoutMs ?? REMOTE_TRANSCRIPT_TOTAL_TIMEOUT_MS
  const parentDir = deps.tmpRoot ?? tmpdir()

  return async ({ targetId, remotePath, signal }) => {
    signal.throwIfAborted()
    // Why mkdtemp with a random suffix: a fixed name under a shared /tmp is pre-creatable
    // by another local user, and this file holds a transcript.
    const dir = await mkdtemp(join(parentDir, 'orca-session-summary-'))
    const dispose = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    // Why the remote basename: parsers derive a session id from the file name.
    const localPath = join(dir, localTranscriptName(remotePath))
    try {
      const result = await streamRemoteFile({
        channel: await deps.openChannel({
          targetId,
          // Quoted: the path comes from the host's own hook, not from this process.
          command: `cat ${quotePosixShell(remotePath)}`,
          signal
        }),
        localPath,
        maxBytes,
        timeoutMs,
        totalTimeoutMs,
        signal
      })
      if (result.kind !== 'file') {
        await dispose()
        return result
      }
      return { kind: 'file', path: localPath, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}

async function streamRemoteFile(args: {
  channel: RemoteTranscriptChannel
  localPath: string
  maxBytes: number
  timeoutMs: number
  totalTimeoutMs: number
  signal: AbortSignal
}): Promise<RemoteTranscriptFetch> {
  const { channel, localPath, maxBytes, timeoutMs, totalTimeoutMs, signal } = args
  if (signal.aborted) {
    // Why close: `cat` would otherwise sit blocked on a full window with no reader.
    channel.close()
    throw new Error('remote transcript read canceled')
  }
  const sink = createWriteStream(localPath, { mode: 0o600 })
  let bytes = 0
  let overflow = false

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let settled = false
    // Two deadlines: an idle one that a moving transfer keeps pushing back, and an overall ceiling
    // that a trickle cannot. One number cannot serve both a stalled link and a slow one.
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => fail(new Error('remote transcript read timed out')), timeoutMs)
    }
    const totalTimer = setTimeout(
      () => fail(new Error('remote transcript read exceeded its overall time limit')),
      totalTimeoutMs
    )
    const settle = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      clearTimeout(totalTimer)
      signal.removeEventListener('abort', onAbort)
      channel.off('data', onData)
      channel.off('error', fail)
      channel.off('close', onClose)
      fn()
    }
    const fail = (error: Error): void => {
      settle(() => {
        channel.close()
        sink.destroy()
        reject(error)
      })
    }
    const onAbort = (): void => fail(new Error('remote transcript read canceled'))
    const onData = (chunk: Buffer): void => {
      armIdle()
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        // Stop reading the moment it cannot fit: the whole file is unusable, not a tail.
        overflow = true
        settle(() => {
          channel.close()
          sink.destroy()
          resolve(null)
        })
        return
      }
      sink.write(chunk)
    }
    // Why on `close` and not `end`: an SSH channel reports its exit status after the
    // data ends, and a partial copy that read a non-zero exit must never be parsed as
    // the whole transcript.
    const onClose = (code?: number | null): void => {
      const status = typeof code === 'number' ? code : null
      settle(() => {
        // Why the callback's error: a failed final flush (a full disk) otherwise resolves
        // as a complete transcript, which is the truncation this reader exists to refuse.
        sink.end((error?: Error | null) => (error ? reject(error) : resolve(status)))
      })
    }
    armIdle()
    signal.addEventListener('abort', onAbort, { once: true })
    // An unwritable target throws out of the write stream, not out of this scope.
    sink.on('error', fail)
    channel.on('data', onData)
    channel.on('error', fail)
    channel.on('close', onClose)
  })

  if (overflow) {
    return { kind: 'too-large', bytes }
  }
  // Nothing came back: the file is not there to read (or the shell never ran).
  if (bytes === 0) {
    return { kind: 'missing' }
  }
  // Why demand a clean exit: a dropped connection or a killed process closes the channel
  // with no status, and parsing what arrived would fold a truncated transcript as if it
  // were the whole one — leaving the ledger's cursor pointing at the wrong messages.
  if (exitCode !== 0) {
    throw new Error(
      exitCode === null
        ? 'reading the transcript on the host did not complete'
        : `reading the transcript on the host failed (exit ${exitCode})`
    )
  }
  return { kind: 'file', path: localPath, dispose: async () => {} }
}

// Why: the name is host-supplied and this copy is created on the client, which may be
// Windows — where `:` and `?` are not legal filename characters at all.
// oxlint-disable-next-line no-control-regex -- SAFETY: control characters are exactly what a filename cannot contain.
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

function localTranscriptName(remotePath: string): string {
  const name = basename(remotePath).replace(UNSAFE_FILENAME_CHARS, '_')
  return name && name !== '.' && name !== '..' ? name : 'transcript.jsonl'
}
