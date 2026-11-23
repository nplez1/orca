// The channel's file I/O, off the main thread. Every one of these paths runs on a delivery or a turn end,
// not once at startup, so a synchronous read here stalls every window (the same reason the webhook store
// uses `writeSecureFileAsync`). Three answers from a read, because "absent" and "unreadable" must not be
// confused: the second is what stops a write from replacing data that still names live projects and keys.
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'

export type PhotonFileRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'parsed'; value: unknown }

/** What is in the file. The parse error is never logged: V8 quotes the input in it, which for the
 *  secrets file would put part of a key into a log. */
export async function readPhotonJson(path: string, what: string): Promise<PhotonFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('[photon] could not read the', what, 'file')
      return { kind: 'unreadable' }
    }
    return { kind: 'missing' }
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) }
  } catch {
    console.warn('[photon] the', what, 'file is not JSON')
    return { kind: 'unreadable' }
  }
}

/** Owner-only and durable, staged off the thread on POSIX; on win32 the helper is synchronous. */
export async function writePhotonJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // `false` means owner-only permissions could not be published, which is reported rather than treated
  // as a failed write: the file is there either way.
  if (!(await writeSecureFileAsync(path, JSON.stringify(value, null, 2), { durable: true }))) {
    console.warn('[photon] could not publish owner-only permissions for', path)
  }
}

export async function listPhotonDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('[photon] could not list a directory:', path)
    }
    return []
  }
}

export async function removePhotonDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
