import { constants as fsConstants } from 'node:fs'
import { access, copyFile, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { Store } from '../persistence'
import { ensureFloatingWorkspaceLaunchDirectory } from '../floating-workspace-launch-directory'
import { authorizeExternalPath } from './filesystem-auth'

/** Pre-folder builds kept floating markdown notes beside the rest of the app data. */
const LEGACY_FLOATING_NOTES_DIRNAME = 'floating-workspace'

function expandHomePath(input: string, home: string): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(home, input.slice(2))
  }
  if (process.platform === 'win32' && input.startsWith('~/')) {
    return path.join(home, input.slice(2))
  }
  return input
}

function resolveFloatingWorkspaceInput(input: string): string {
  const home = app.getPath('home')
  const expanded = expandHomePath(input, home)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(home, expanded)
}

async function canonicalizeAccessibleDirectory(dirPath: string): Promise<string | null> {
  try {
    const dirStats = await stat(dirPath)
    if (!dirStats.isDirectory()) {
      return null
    }
    await access(dirPath, fsConstants.R_OK | fsConstants.X_OK)
    return path.resolve(await realpath(dirPath))
  } catch {
    return null
  }
}

function getTrustedFloatingWorkspaceDirectories(settings: GlobalSettings): Set<string> {
  return new Set(
    (settings.floatingTerminalTrustedCwds ?? [])
      .map((trustedPath) => trustedPath.trim())
      .filter((trustedPath) => trustedPath.length > 0)
      .map(resolveFloatingWorkspaceInput)
  )
}

async function getPreservedTrustedFloatingWorkspaceDirectories(
  settings: GlobalSettings
): Promise<Set<string>> {
  const trustedDirectories = new Set<string>()
  for (const trustedDir of getTrustedFloatingWorkspaceDirectories(settings)) {
    const canonicalDir = await canonicalizeAccessibleDirectory(trustedDir)
    trustedDirectories.add(canonicalDir ?? trustedDir)
  }
  return trustedDirectories
}

function isTrustedFloatingWorkspaceDirectory(
  canonicalDirPath: string,
  settings: GlobalSettings
): boolean {
  return getTrustedFloatingWorkspaceDirectories(settings).has(path.resolve(canonicalDirPath))
}

/**
 * The Floating Workspace folder (`~/.orca/floating-workspace`): where its terminals and agents
 * start by default, and where its markdown notes always live (even when the start directory is
 * pointed elsewhere). Created and authorized on first use.
 *
 * Why not `~`: floating terminals and agents must not inherit a project — or the whole home
 * directory — as their working directory, and agent CLIs read `AGENTS.md` from the cwd, so the
 * folder is where floating-workspace instructions live.
 */
export async function ensureFloatingWorkspaceDirectory(): Promise<string> {
  const cwd = await ensureFloatingWorkspaceLaunchDirectory(app.getPath('home'))
  // Why: the folder is app-created, so file access in it (notes included) is always allowed.
  authorizeExternalPath(cwd)
  await moveLegacyFloatingNotes(cwd)
  return cwd
}

/**
 * Moves notes out of the app-data directory older builds used, so the floating workspace folder is
 * the only place floating notes live.
 *
 * Why a move rather than a second lookup root: leaving copies behind would silently split the
 * user's notes across two directories. Anything that cannot move — a name already taken at the
 * destination, or an entry that is neither renamable nor copyable — stays put instead of being
 * overwritten or deleted.
 */
async function moveLegacyFloatingNotes(destination: string): Promise<void> {
  const legacy = path.join(app.getPath('userData'), LEGACY_FLOATING_NOTES_DIRNAME)
  if (path.resolve(legacy) === path.resolve(destination)) {
    return
  }
  const entries = await readdir(legacy).catch(() => null)
  if (!entries || entries.length === 0) {
    return
  }
  let moved = 0
  for (const entry of entries) {
    if (await moveLegacyFloatingNote(path.join(legacy, entry), path.join(destination, entry))) {
      moved += 1
    }
  }
  if (moved < entries.length) {
    // Why: leftovers mean the legacy folder is not ours to remove, and a later launch retries.
    return
  }
  // Why rmdir: it removes only our still-empty directory, so a note left behind keeps it around.
  await rmdir(legacy).catch(() => undefined)
}

async function moveLegacyFloatingNote(from: string, to: string): Promise<boolean> {
  // Why: rename() replaces an existing destination on POSIX, and a note the user already has in
  // the floating workspace folder is newer than the legacy copy.
  if (await pathExists(to)) {
    return false
  }
  try {
    await rename(from, to)
    return true
  } catch {
    // Why not bail: this also fires across filesystems, which the copy below can still handle.
  }
  try {
    await copyFile(from, to, fsConstants.COPYFILE_EXCL)
  } catch {
    return false
  }
  // Why best-effort: the note is already at the destination, so a leftover source only wastes space.
  await unlink(from).catch(() => undefined)
  return true
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export async function resolveFloatingTerminalCwd(
  store: Pick<Store, 'getSettings'>,
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  const configuredPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!configuredPath) {
    return ensureFloatingWorkspaceDirectory()
  }

  const cwd = resolveFloatingWorkspaceInput(configuredPath)
  const canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
  if (!canonicalCwd) {
    return ensureFloatingWorkspaceDirectory()
  }

  if (isTrustedFloatingWorkspaceDirectory(canonicalCwd, store.getSettings())) {
    // Why: picker-approved directories are persisted as explicit grants, so a
    // restart can restore file creation access without trusting arbitrary text.
    authorizeExternalPath(canonicalCwd)
    return canonicalCwd
  }

  return args?.requireTrusted === true ? ensureFloatingWorkspaceDirectory() : cwd
}

export async function grantFloatingWorkspaceDirectory(
  store: Store,
  dirPath: string
): Promise<void> {
  const resolvedDir = resolveFloatingWorkspaceInput(dirPath)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir) {
    return
  }
  authorizeExternalPath(canonicalDir)
  const trustedDirectories = await getPreservedTrustedFloatingWorkspaceDirectories(
    store.getSettings()
  )
  trustedDirectories.add(canonicalDir)
  store.updateSettings({
    floatingTerminalTrustedCwds: [...trustedDirectories]
  })
}

export async function sanitizeFloatingWorkspaceDirectorySetting(
  store: Pick<Store, 'getSettings'>,
  dirPath: string
): Promise<string> {
  const trimmed = dirPath.trim()
  if (!trimmed) {
    return ''
  }
  const resolvedDir = resolveFloatingWorkspaceInput(trimmed)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir || !isTrustedFloatingWorkspaceDirectory(canonicalDir, store.getSettings())) {
    return ''
  }
  return canonicalDir
}
