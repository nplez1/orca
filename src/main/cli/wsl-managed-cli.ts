import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { DEV_COMMAND_NAME, CLI_COMMAND_NAME } from './cli-install-constants'
import { buildColocatedWslLauncher, buildWslBridgeScript } from './wsl-cli-scripts'

/**
 * Name of the launcher written into the managed WSL CLI directory.
 *
 * Why this and not the in-bundle Linux launcher name: the WSL restore script exports PATH only when
 * `$ORCA_WSL_CLI_DIR/$ORCA_CLI_COMMAND` is executable, so the managed launcher must carry the same
 * name the PTY env exports and the guest registration uses (`orca-np`; `orca-np-dev` from a dev
 * build). Upstream's `orca-ide` there would collide with an official install's registration.
 */
export function getManagedWslCliLauncherName(isPackaged: boolean): string {
  return isPackaged ? CLI_COMMAND_NAME : DEV_COMMAND_NAME
}

let warnedMissingRuntime = false

// Content-addressed, atomically published files let builds share userData without overwriting peers.
export function getManagedWslCliDir(opts: {
  isPackaged: boolean
  userDataPath: string
  resourcesPath?: string
}): string | null {
  const cliEntryPath = opts.isPackaged
    ? undefined
    : join(getAppEnvironment().getAppPath(), 'out', 'cli', 'index.js')
  const launcherPath = opts.isPackaged
    ? opts.resourcesPath && getBundledLauncherPath('win32', opts.resourcesPath)
    : process.execPath
  if (!launcherPath || !existsSync(cliEntryPath ?? launcherPath)) {
    if (!warnedMissingRuntime) {
      warnedMissingRuntime = true
      console.warn('[WSL CLI] Orca CLI runtime is missing; WSL terminals will not provide it.')
    }
    return null
  }
  const launcher = buildColocatedWslLauncher(launcherPath, windowsPowerShellPath())
  const bridge = buildWslBridgeScript({ userDataPath: opts.userDataPath, cliEntryPath })
  const digest = createHash('sha256').update(launcher).update(bridge).digest('hex').slice(0, 20)
  const directory = join(opts.userDataPath, 'wsl-managed-cli', digest)
  const files = [
    [join(directory, getManagedWslCliLauncherName(opts.isPackaged)), launcher],
    [join(directory, 'orca-wsl-bridge.ps1'), bridge]
  ] as const
  const ready =
    files.every(([path]) => existsSync(path)) ||
    writeShellWrapperFiles(files, '[WSL CLI]', 'WSL terminals will start without the Orca CLI')
  return ready ? directory : null
}
