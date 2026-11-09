/**
 * The install-layout names this build owns, and the platform paths derived from them.
 *
 * Why one module: each name follows a *different* electron-builder field, so a reader seeing one
 * literal cannot tell which field it follows, and a rename that misses one leaves a path resolving
 * an official Orca install instead of this one. Every consumer imports from here so they move
 * together. Why not upstream's names: this fork is installed beside an official Orca, so a path
 * naming `Orca`/`orca.exe`/`com.stablyai.orca` acts on the other app (LOCAL-PATCHES.md
 * § `local(identity)`).
 *
 * Field map, from `config/electron-builder.np.config.cjs`:
 * - macOS bundle and its executable follow `productName` (electron-builder defaults
 *   `mac.executableName` to it, and `resources/darwin/bin/orca` already names `MacOS/Orca NP`).
 * - The Windows executable follows `win.executableName` = `productName`; NSIS names its uninstaller
 *   `Uninstall <that>` (`templates/nsis/common.nsh` `UNINSTALL_FILENAME`).
 * - The Windows per-user install directory follows `extraMetadata.name`, i.e. the package name:
 *   NSIS's `APP_FILENAME` is `appInfo.sanitizedName` for a one-click per-user install, not the
 *   product name (`app-builder-lib` `getWindowsInstallationDirName`).
 * - The Linux payload directory is `/opt/${sanitizedProductName}` (FpmTarget) and the executable
 *   inside it is `linux.executableName` = the package name.
 * - The launchd label follows the appId, because the job already declares itself to launchd under
 *   it (`AssociatedBundleIdentifiers` in `macos-daemon-launchd.ts`).
 */

import { createHash } from 'node:crypto'
import { posix, resolve, win32 } from 'node:path'
import {
  APP_DATA_DIRECTORY_NAME,
  DEV_APP_DATA_DIRECTORY_NAME
} from '../../shared/app-directory-names'
import { APP_DISPLAY_NAME } from '../../shared/app-display-name'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import { CLI_COMMAND_NAME } from '../cli/cli-install-constants'

/** `Orca NP.app` — the bundle an installer places in `/Applications` or `~/Applications`. */
export const MAC_APP_BUNDLE_NAME = `${APP_DISPLAY_NAME}.app`

/** The bundle's `CFBundleExecutable`, i.e. `Contents/MacOS/Orca NP`. */
export const MAC_APP_EXECUTABLE_NAME = APP_DISPLAY_NAME

/** `Orca NP.exe` — `win.executableName`, and what NSIS installs beside the runtime files. */
export const WINDOWS_APP_EXECUTABLE_NAME = `${APP_DISPLAY_NAME}.exe`

/** `Uninstall Orca NP.exe` — NSIS derives it from the same name. */
export const WINDOWS_UNINSTALLER_NAME = `Uninstall ${APP_DISPLAY_NAME}.exe`

/**
 * The package name NSIS uses for the install directory: `extraMetadata.name`, which the overlay sets
 * to the CLI command name.
 */
export const WINDOWS_INSTALL_DIRECTORY_NAME = CLI_COMMAND_NAME

/**
 * `%LOCALAPPDATA%\Programs\orca` — where builds from before the package rename install, and where
 * NSIS keeps updating them in place because the appId did not change.
 *
 * Why it is still a candidate: such an install runs *this* build, so the executable inside it is
 * `Orca NP.exe`. It cannot be confused with the official install's copy in the same folder, whose
 * executable is `Orca.exe` — the name inside is what tells them apart.
 */
export const WINDOWS_LEGACY_INSTALL_DIRECTORY_NAME = 'orca'

/** `/opt/<this>` — FpmTarget stages the deb/rpm payload under the sanitized product name. */
export const LINUX_INSTALL_DIRECTORY_NAME = APP_DISPLAY_NAME

/**
 * `linux.executableName`, i.e. `/opt/Orca NP/orca-np` — the package name, not the product name, because
 * deb/rpm payload paths are named after it.
 */
export const LINUX_APP_EXECUTABLE_NAME = CLI_COMMAND_NAME

/**
 * `com.nplez1.orca.terminal` — the launchd job prefix for the packaged macOS terminal daemon.
 *
 * Why the appId and not upstream's: the job is already attributed to this app for Local Network
 * access through `AssociatedBundleIdentifiers`, and the helper bundle's `CFBundleIdentifier` is
 * asserted equal to the appId, so a label naming the other app is the odd one out.
 */
export const MAC_DAEMON_JOB_LABEL_PREFIX = `${LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId}.terminal`

/**
 * The prefix builds before this rename registered, retired once per profile at launch.
 *
 * Why it is a literal and stays one: it names *the other app's* identity on purpose — it is the
 * label our own earlier builds left behind, so it has to keep matching what they wrote. The profile
 * hash in the label is derived from this build's own `userDataPath`, so the only job this can ever
 * match is one of ours; an official install's `userDataPath` hashes differently.
 */
export const LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX = 'com.stablyai.orca.terminal'

/**
 * Application Support / `%APPDATA%` directories this build writes agent-hook endpoints into.
 *
 * Why these four: the packaged app, plain `pnpm dev`, the shared dev profile, and per-worktree dev
 * profiles are four different `userData` roots (`configure-process.ts`,
 * `dev-instance-isolation.mjs`). An official install's `orca` root is deliberately absent — a hook
 * that adopted its endpoint would post to the other app whenever the two share a loopback port.
 */
export const HOOK_ENDPOINT_APP_DATA_DIRECTORY_NAMES = [
  APP_DATA_DIRECTORY_NAME,
  DEV_APP_DATA_DIRECTORY_NAME
]

/** The per-worktree dev profile root, unchanged from upstream (`WORKTREE_DEV_PROFILES_DIR_NAME`). */
export const HOOK_ENDPOINT_WORKTREE_PROFILE_DIRECTORY_NAME = 'orca-dev-wt'

/** The shared dev profile root, unchanged from upstream (`SHARED_DEV_PROFILE_DIR_NAME`). */
export const HOOK_ENDPOINT_SHARED_DEV_PROFILE_DIRECTORY_NAME = 'orca-dev'

export function macDaemonJobLabelWith(
  prefix: string,
  userDataPath: string,
  protocolVersion: number
): string {
  const profileKey = createHash('sha256').update(resolve(userDataPath)).digest('hex').slice(0, 16)
  return `${prefix}.${profileKey}.v${protocolVersion}`
}

/**
 * Installer-owned paths that can serve as this app's own Electron browser host.
 *
 * Why not the official install's paths: orcad spawns the resolved binary with `--serve`, so a
 * candidate naming the other app starts the other app's browser host. `null` is the correct answer
 * when this build is not installed, and the caller already handles it.
 */
export function installedAppExecutableCandidates(
  platform: NodeJS.Platform,
  homePath: string,
  environment: NodeJS.ProcessEnv
): string[] {
  const joinPath = platform === 'win32' ? win32.join : posix.join
  if (platform === 'darwin') {
    return [
      joinPath('/Applications', MAC_APP_BUNDLE_NAME, 'Contents', 'MacOS', MAC_APP_EXECUTABLE_NAME),
      joinPath(
        homePath,
        'Applications',
        MAC_APP_BUNDLE_NAME,
        'Contents',
        'MacOS',
        MAC_APP_EXECUTABLE_NAME
      )
    ]
  }
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA
    const programFiles = environment.ProgramFiles
    return [
      ...(localAppData
        ? [WINDOWS_INSTALL_DIRECTORY_NAME, WINDOWS_LEGACY_INSTALL_DIRECTORY_NAME].map((directory) =>
            joinPath(localAppData, 'Programs', directory, WINDOWS_APP_EXECUTABLE_NAME)
          )
        : []),
      ...(programFiles
        ? [joinPath(programFiles, WINDOWS_INSTALL_DIRECTORY_NAME, WINDOWS_APP_EXECUTABLE_NAME)]
        : [])
    ]
  }
  return [
    joinPath('/opt', LINUX_INSTALL_DIRECTORY_NAME, LINUX_APP_EXECUTABLE_NAME),
    joinPath('/opt', CLI_COMMAND_NAME, LINUX_APP_EXECUTABLE_NAME)
  ]
}
