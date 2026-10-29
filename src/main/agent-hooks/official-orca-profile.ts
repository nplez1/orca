import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The appData child an official Orca install owns. Deliberately a literal: this build must never
 * derive it from its own identity constants, and the value belongs to another application.
 */
const OFFICIAL_DATA_DIRECTORY_NAME = 'orca'

/** Where an official Orca install keeps its profile, matching Electron's per-platform appData. */
export function officialOrcaProfilePath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', OFFICIAL_DATA_DIRECTORY_NAME)
  }
  if (platform === 'win32') {
    return env.APPDATA ? join(env.APPDATA, OFFICIAL_DATA_DIRECTORY_NAME) : null
  }
  return join(env.XDG_CONFIG_HOME || join(homeDirectory, '.config'), OFFICIAL_DATA_DIRECTORY_NAME)
}

/**
 * Whether an official Orca install has ever run here, and so owns its copy of the shared
 * `~/.orca` directory.
 *
 * Why the profile rather than the app bundle: a hook entry can only exist for an install that has
 * launched, and every launch creates this directory. Its absence therefore means the pre-rename
 * `~/.orca` entries are this build's own leftovers, safe to sweep.
 *
 * Scoped to the caller, not to this module: tests inject a disposable home, and the real answer
 * changes as soon as the user installs or removes the official app.
 */
export function hasOfficialOrcaProfile(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const profilePath = officialOrcaProfilePath(platform, homeDirectory, env)
  return profilePath !== null && existsSync(profilePath)
}
