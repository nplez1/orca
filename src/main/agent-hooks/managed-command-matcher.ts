import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'
import {
  getWindowsNativeHookAgent,
  WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME
} from './windows-native-hook-executable'
import { hasOfficialOrcaProfile } from './official-orca-profile'

export type ManagedCommandMatcherOptions = {
  /**
   * Whether an entry under `LEGACY_HOME_DIRECTORY_NAME` may belong to this build. Defaults to the
   * host probe in {@link hasOfficialOrcaProfile}; injectable so a test never depends on the machine.
   */
  sweepLegacyHomeDirectory?: boolean
}

/**
 * Match script names so reinstalls sweep the entries this install wrote.
 *
 * Why anchored on a home-directory child: an official Orca install registers its own scripts in the
 * same provider config, under `~/.orca/agent-hooks/<script>`. Matching the bare `agent-hooks/<script>`
 * tail made each app delete the other's hooks, which only worked while exactly one install existed.
 */
export function createManagedCommandMatcher(
  scriptFileName: string,
  options: ManagedCommandMatcherOptions = {}
): (command: string | undefined) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/, '')
  const ownNeedles = managedCommandNeedles(HOME_DIRECTORY_NAME, scriptFileName, scriptStem)
  const ownNativeHook = nativeHookNeedle(HOME_DIRECTORY_NAME, scriptFileName)
  const legacyNeedles = managedCommandNeedles(
    LEGACY_HOME_DIRECTORY_NAME,
    scriptFileName,
    scriptStem
  )
  const legacyNativeHook = nativeHookNeedle(LEGACY_HOME_DIRECTORY_NAME, scriptFileName)
  const sweepsLegacyHome = options.sweepLegacyHomeDirectory ?? !hasOfficialOrcaProfile()
  // Why: a resolved path under this user's own `~/.orca` is an official install's, while a remote
  // host's or a frozen `${HOME}` template's `.orca` path is this build's own registration.
  const localLegacyRoot = normalizeHookCommandPath(
    join(homedir(), LEGACY_HOME_DIRECTORY_NAME)
  ).toLowerCase()
  return (command) => {
    if (!command) {
      return false
    }
    const lines = hookCommandLines(command)
    if (matchesManagedHook(lines, ownNeedles, ownNativeHook)) {
      return true
    }
    const legacyLines = sweepsLegacyHome
      ? lines
      : lines.filter((line) => !line.toLowerCase().includes(localLegacyRoot))
    return matchesManagedHook(legacyLines, legacyNeedles, legacyNativeHook)
  }
}

function managedCommandNeedles(
  homeDirectoryName: string,
  scriptFileName: string,
  scriptStem: string
): string[] {
  // Sweep every platform suffix after a platform switch.
  return [
    `${homeDirectoryName}/agent-hooks/${scriptFileName}`,
    `${homeDirectoryName}/agent-hooks/${scriptStem}.cmd`,
    `${homeDirectoryName}/agent-hooks/${scriptStem}.ps1`,
    `${homeDirectoryName}/agent-hooks/${scriptStem}.sh`
  ]
}

/** The native executable selects its provider through argv[1]. */
function nativeHookNeedle(homeDirectoryName: string, scriptFileName: string): string {
  return `${homeDirectoryName}/agent-hooks/${WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME} ${getWindowsNativeHookAgent(scriptFileName)} `
}

function normalizeHookCommandPath(command: string): string {
  return command.replaceAll('\\', '/')
}

function hookCommandLines(command: string): string[] {
  const decodedCommand = decodePowerShellEncodedCommand(command)
  const searchText = decodedCommand ? `${command}\n${decodedCommand}` : command
  return normalizeHookCommandPath(searchText).split('\n')
}

function matchesManagedHook(lines: string[], needles: string[], nativeHook: string): boolean {
  return lines.some(
    (line) => needles.some((needle) => line.includes(needle)) || `${line} `.includes(nativeHook)
  )
}

function decodePowerShellEncodedCommand(command: string): string | null {
  const match = command.match(/\s-EncodedCommand\s+(\S+)/i)
  if (!match) {
    return null
  }
  try {
    return Buffer.from(match[1], 'base64').toString('utf16le')
  } catch {
    return null
  }
}
