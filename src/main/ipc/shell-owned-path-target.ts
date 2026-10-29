import { realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
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
  const target = await statLocalTarget(pathValue, pathApi)
  return target.ok ? { ok: true, path: target.path } : target
}

function statLocalTarget(
  pathValue: string,
  pathApi: { normalize: (path: string) => string; isAbsolute: (path: string) => boolean } = {
    normalize,
    isAbsolute
  }
): Promise<
  { ok: true; path: string; stats: Stats } | { ok: false; reason: 'not-absolute' | 'not-found' }
> {
  const normalizedPath = pathApi.normalize(pathValue)
  if (!pathApi.isAbsolute(normalizedPath)) {
    return Promise.resolve({ ok: false, reason: 'not-absolute' })
  }
  return stat(normalizedPath).then(
    (stats) => ({ ok: true as const, path: normalizedPath, stats }),
    () => ({ ok: false as const, reason: 'not-found' as const })
  )
}

/**
 * Extensions a default-app launch hands to an interpreter or a package loader rather than to an
 * application that opens a document: `.command`/`.tool`/`.terminal` run in Terminal on macOS,
 * bundles (`.app`, `.workflow`) launch through LaunchServices, and the Windows kinds are launchers
 * or script hosts too.
 *
 * Why a deny list rather than an allow list of documents: a deny list cannot break the media,
 * PDF and archive previews that legitimately use "open with the default app", and these kinds have
 * no other meaning than "execute this".
 */
const EXECUTABLE_LAUNCH_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.cpl',
  '.com',
  '.command',
  '.desktop',
  '.exe',
  '.fileloc',
  '.hta',
  '.jar',
  '.lnk',
  '.msc',
  '.msi',
  '.pif',
  '.ps1',
  '.reg',
  '.scr',
  '.terminal',
  '.tool',
  '.url',
  '.vbs',
  '.workflow',
  '.wsf'
])
/** Kinds Windows alone runs through a script host; refusing them elsewhere would only break editors. */
const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.js', '.jse', '.vbe'])

/**
 * The extension a launch would act on.
 *
 * Why strip trailing dots and spaces first: Win32 removes them when it opens the file, so
 * `evil.exe.` runs `evil.exe` while `extname` reports `.` alone.
 */
function launchExtension(path: string): string {
  return extname(path.replace(/[.\s]+$/, '')).toLowerCase()
}

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
  const target = await statLocalTarget(pathValue)
  if (!target.ok) {
    return target
  }
  // Why resolve the link: `stat` already follows it, so the type has to be read from the file it
  // describes. `docs/guide -> ../Payload.app` is a bundle launch with no extension of its own.
  const realPath = await realpath(target.path).catch(() => target.path)
  if (isExecutableOpenTarget(realPath, target.stats)) {
    return { ok: false, reason: 'executable-target' }
  }
  return { ok: true, path: target.path }
}

function isExecutableOpenTarget(path: string, stats: Stats): boolean {
  const extension = launchExtension(path)
  // A bundle is a directory, so the extension decides before `isFile` is consulted.
  if (EXECUTABLE_LAUNCH_EXTENSIONS.has(extension)) {
    return true
  }
  if (process.platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extension)) {
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
