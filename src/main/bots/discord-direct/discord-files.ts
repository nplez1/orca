// The channel's file I/O, off the main thread: a delivery and a turn end both consult these files, so a
// synchronous read here stalls every window. Three answers from a read, because "absent" and "unreadable"
// must not be confused: the second is what stops a write from replacing data it cannot see.
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'

export type DiscordFileRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'parsed'; value: unknown }

/** The parse error is never logged: V8 quotes the input in it, which for the secrets file would put part
 *  of a token into a log. */
export async function readDiscordJson(path: string, what: string): Promise<DiscordFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('[discord] could not read the', what, 'file')
      return { kind: 'unreadable' }
    }
    return { kind: 'missing' }
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) }
  } catch {
    console.warn('[discord] the', what, 'file is not JSON')
    return { kind: 'unreadable' }
  }
}

/** Owner-only and durable, staged off the thread on POSIX; on win32 the helper is synchronous. */
export async function writeDiscordJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // `false` means owner-only permissions could not be published, which is reported rather than treated
  // as a failed write: the file is there either way.
  if (!(await writeSecureFileAsync(path, JSON.stringify(value, null, 2), { durable: true }))) {
    console.warn('[discord] could not publish owner-only permissions for', path)
  }
}

export async function listDiscordDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('[discord] could not list a directory:', path)
    }
    return []
  }
}

export async function removeDiscordDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

const queues = new Map<string, Promise<void>>()

/** One change at a time per file, so two claims or two settles cannot each read the state the other is
 *  about to replace. The queue outlives a failed change, so one refusal does not wedge every later one. */
export function serialiseByFile<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  const result = previous.then(run)
  queues.set(
    path,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}
