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
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'
import { shellEscape } from '../ssh/ssh-connection-utils'

/** The subset of an SSH exec channel this reader consumes. */
export type RemoteTranscriptChannel = Readable & { close(): void }

export type RemoteTranscriptFetch =
  /** A local copy ready to parse; `dispose` removes it. */
  | { kind: 'file'; path: string; dispose: () => Promise<void> }
  /** Above the cap: refused rather than silently truncated into a wrong cursor. */
  | { kind: 'too-large'; bytes: number }
  /** Nothing came back: no such file, or an empty one. */
  | { kind: 'missing' }

/** 24 MB: well above a long pi/Claude session, and a bound this app can hold twice. */
export const REMOTE_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024
const REMOTE_TRANSCRIPT_TIMEOUT_MS = 120_000

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
}

export function createSshTranscriptFetcher(
  deps: SshTranscriptFetcherDeps
): (args: {
  targetId: string
  remotePath: string
  signal: AbortSignal
}) => Promise<RemoteTranscriptFetch> {
  const maxBytes = deps.maxBytes ?? REMOTE_TRANSCRIPT_MAX_BYTES
  const timeoutMs = deps.timeoutMs ?? REMOTE_TRANSCRIPT_TIMEOUT_MS
  const tmpRoot = deps.tmpRoot ?? join(tmpdir(), 'orca-session-summary-remote')

  return async ({ targetId, remotePath, signal }) => {
    const dir = join(tmpRoot, randomUUID())
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const dispose = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    // Why the remote basename: parsers derive a session id from the file name.
    const localPath = join(dir, basename(remotePath) || 'transcript.jsonl')
    try {
      const result = await streamRemoteFile({
        channel: await deps.openChannel({
          targetId,
          // Quoted: the path comes from the host's own hook, not from this process.
          command: `cat ${shellEscape(remotePath)}`,
          signal
        }),
        localPath,
        maxBytes,
        timeoutMs,
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
  signal: AbortSignal
}): Promise<RemoteTranscriptFetch> {
  const { channel, localPath, maxBytes, timeoutMs, signal } = args
  const sink = createWriteStream(localPath, { mode: 0o600 })
  let bytes = 0
  let overflow = false
  let exitCode: number | null = null

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
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
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        // Stop reading the moment it cannot fit: the whole file is unusable, not a tail.
        overflow = true
        settle(() => {
          channel.close()
          sink.destroy()
          resolve()
        })
        return
      }
      sink.write(chunk)
    }
    // Why on `close` and not `end`: an SSH channel reports its exit status after the
    // data ends, and a partial copy that read a non-zero exit must never be parsed as
    // the whole transcript.
    const onClose = (code?: number | null): void => {
      exitCode = typeof code === 'number' ? code : null
      settle(() => {
        sink.end(() => resolve())
      })
    }
    const timer = setTimeout(() => fail(new Error('remote transcript read timed out')), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    channel.on('data', onData)
    channel.on('error', fail)
    channel.on('close', onClose)
  })

  if (overflow) {
    return { kind: 'too-large', bytes }
  }
  // Nothing came back and the command failed: the file is not there to read.
  if (bytes === 0) {
    return { kind: 'missing' }
  }
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(`reading the transcript on the host failed (exit ${exitCode})`)
  }
  return { kind: 'file', path: localPath, dispose: async () => {} }
}
