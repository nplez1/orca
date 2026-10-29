import { stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize, win32 } from 'node:path'
import { parseRoutableExecutionHostId } from '../../shared/execution-host'
import type { ShellOpenLocalPathFailureReason } from '../../shared/shell-open-types'
import { resolveWindowsPathAccess } from '../windows-path-access-host'

export async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

export async function validateLocalPathTarget(
  pathValue: string,
  // Injectable path rules allow checking Windows-only WSL UNC paths.
  pathApi: { normalize: (path: string) => string; isAbsolute: (path: string) => boolean } = {
    normalize,
    isAbsolute
  }
): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-absolute' | 'not-found' }> {
  const normalizedPath = pathApi.normalize(pathValue)
  if (!pathApi.isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  if (!(await pathExists(normalizedPath))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, path: normalizedPath }
}

/**
 * Extensions a default-app launch hands to an interpreter or a package loader rather than to an
 * application that opens a document: `.command`/`.tool`/`.terminal` run in Terminal on macOS,
 * `.app` launches a bundle, and the Windows kinds are launchers too.
 *
 * Why a deny list rather than an allow list of documents: a deny list cannot break the media,
 * PDF and archive previews that legitimately use "open with the default app", and these kinds have
 * no other meaning than "execute this".
 */
const EXECUTABLE_LAUNCH_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.command',
  '.desktop',
  '.exe',
  '.lnk',
  '.ps1',
  '.terminal',
  '.tool',
  '.url',
  '.vbs',
  '.wsf'
])

export type DefaultAppOpenTarget =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-absolute' | 'not-found' | 'executable-target' }

/**
 * Target for `shell.openPath`, which is an execute request on macOS and Windows.
 *
 * The path arrives from markdown links and from terminal output inside a workspace, so it is
 * untrusted by construction: a cloned repo can carry a README pointing at `./docs/guide.command`,
 * Git preserves the executable bit, and a clone adds no quarantine flag to make Gatekeeper ask.
 * Absolute-and-exists is therefore not enough here — the file type is part of the check.
 */
export async function resolveDefaultAppOpenTarget(
  pathValue: string
): Promise<DefaultAppOpenTarget> {
  const normalizedPath = normalize(pathValue)
  if (!isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  let stats
  try {
    stats = await stat(normalizedPath)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (isExecutableOpenTarget(normalizedPath, stats)) {
    return { ok: false, reason: 'executable-target' }
  }
  return { ok: true, path: normalizedPath }
}

function isExecutableOpenTarget(
  path: string,
  stats: { isFile: () => boolean; mode: number }
): boolean {
  if (EXECUTABLE_LAUNCH_EXTENSIONS.has(extname(path).toLowerCase())) {
    return true
  }
  // Windows synthesizes mode bits, so the executable bit there is not evidence about the file.
  return process.platform !== 'win32' && stats.isFile() && (stats.mode & 0o111) !== 0
}

// Route by path owner, never the focused server; missing ownership must fail.
export function isLocallyOwned(ownerHostId: unknown): boolean {
  return (
    typeof ownerHostId === 'string' && parseRoutableExecutionHostId(ownerHostId)?.kind === 'local'
  )
}

/** Resolve local paths or WSL-owner UNC paths; refuse other owners. */
export async function resolveOwnedPathTarget(
  pathValue: string,
  ownerHostId: unknown
): Promise<{ ok: true; path: string } | { ok: false; reason: ShellOpenLocalPathFailureReason }> {
  if (isLocallyOwned(ownerHostId)) {
    return validateLocalPathTarget(pathValue)
  }
  const access = resolveWindowsPathAccess(ownerHostId)
  if (!access) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  const windowsPath = access.toWindows(pathValue)
  return windowsPath
    ? validateLocalPathTarget(windowsPath, win32)
    : { ok: false, reason: 'not-absolute' }
}
