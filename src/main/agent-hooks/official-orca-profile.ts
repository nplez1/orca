import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The appData child an official Orca install owns. Deliberately a literal: this build must never
 * derive it from its own identity constants, and the value belongs to another application.
 */
const OFFICIAL_DATA_DIRECTORY_NAME = 'orca'

/** The only child this build ever wrote into that profile, before the coordination root moved. */
const PRE_RENAME_PARK_DIRECTORY_NAME = 'bundle-coordination'

/** Where an official Orca install keeps its profile, matching Electron's per-platform appData. */
export function officialOrcaProfilePath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (platform === 'win32') {
    return env.APPDATA ? join(env.APPDATA, OFFICIAL_DATA_DIRECTORY_NAME) : null
  }
  if (platform === 'darwin') {
    return hasHomeDirectory(homeDirectory)
      ? join(homeDirectory, 'Library', 'Application Support', OFFICIAL_DATA_DIRECTORY_NAME)
      : null
  }
  const configHome =
    env.XDG_CONFIG_HOME || (hasHomeDirectory(homeDirectory) ? join(homeDirectory, '.config') : null)
  return configHome ? join(configHome, OFFICIAL_DATA_DIRECTORY_NAME) : null
}

/** Why: a host or a test harness may resolve no home at all, and an unanswerable probe is "absent". */
function hasHomeDirectory(homeDirectory: unknown): homeDirectory is string {
  return typeof homeDirectory === 'string' && homeDirectory.length > 0
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
  return profilePath !== null && existsSync(profilePath) && !holdsOnlyPreRenameParkTree(profilePath)
}

/**
 * Whether the directory holds nothing but the park/ack tree builds before this one wrote there.
 *
 * Why: that tree was the only thing this build ever created under upstream's profile name, so a
 * machine that ran a supervised serve with an older build must not look like an official install
 * forever — the legacy sweep would stay off for good.
 */
function holdsOnlyPreRenameParkTree(profilePath: string): boolean {
  try {
    const entries = readdirSync(profilePath)
    // An empty profile proves nothing either way, so it stays "the official app's": the sweep only
    // ever deletes this build's own leftovers, and a wrong "absent" would take another install's.
    return entries.length > 0 && entries.every((entry) => entry === PRE_RENAME_PARK_DIRECTORY_NAME)
  } catch {
    // Why: an unreadable profile cannot prove the tree was this build's, so treat it as the official app's.
    return false
  }
}
