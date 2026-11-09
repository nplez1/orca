import type { CliInstallStatus } from '../../shared/cli-install-types'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/execution/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'

function makeHostStatus(
  launcherPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca-np.exe'
) {
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: launcherPath,
    pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: launcherPath,
    unsupportedReason: null,
    detail: null
  } satisfies CliInstallStatus
}

// Frozen layout from an earlier build of this fork: the persisted managed script still names the
// pre-native Windows batch launcher, so an upgrade has to recognise and replace it.
const PRE_RENAME_MANAGED_WSL_LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
# Orca NP managed WSL CLI launcher
# ORCA_WIN_LAUNCHER_B64=QzpcUHJvZ3JhbSBGaWxlc1xPcmNhXHJlc291cmNlc1xiaW5cb3JjYS5jbWQ=
ORCA_WIN_LAUNCHER='C:\\Program Files\\Orca\\resources\\bin\\orca.cmd'
ORCA_BRIDGE_PS1='/home/alice/.local/share/orca-np/orca-wsl-bridge.ps1'
if command -v powershell.exe >/dev/null 2>&1; then
  ORCA_POWERSHELL=powershell.exe
elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  ORCA_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
else
  echo "Orca WSL CLI requires Windows interop and could not find powershell.exe." >&2
  exit 1
fi
ORCA_BRIDGE_PS1_WIN=$(wslpath -w "$ORCA_BRIDGE_PS1")
exec "$ORCA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$ORCA_BRIDGE_PS1_WIN" "$ORCA_WIN_LAUNCHER" "$@"
`

/** An official Orca install's own registration: same guest directory, its own command and marker. */
const OFFICIAL_ORCA_WSL_LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
# Orca managed WSL CLI launcher
# ORCA_WIN_LAUNCHER_B64=QzpcVXNlcnNcYWxpY2VcQXBwRGF0YVxMb2NhbFxQcm9ncmFtc1xvcmNhXFJlc291cmNlc1xiaW5cb3JjYS5leGU=
ORCA_WIN_LAUNCHER='C:\\Users\\alice\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File /mnt/c/bridge.ps1 "$ORCA_WIN_LAUNCHER" "$@"
`

function createWslRunner(
  initialFile: string | null = null,
  pathIncludesLocalBin = true,
  options: {
    initialBridge?: string | null
    officialOrcaCommand?: string | null
    failInstall?: boolean
    interopReady?: boolean
  } = {}
) {
  const commandPath = '/home/alice/.local/bin/orca-np'
  const officialCommandPath = '/home/alice/.local/bin/orca-ide'
  const bridgePath = '/home/alice/.local/share/orca-np/orca-wsl-bridge.ps1'
  const files = new Map<string, string>()
  if (initialFile !== null) {
    files.set(commandPath, initialFile)
  }
  if (
    options.initialBridge !== null &&
    (initialFile !== null || options.initialBridge !== undefined)
  ) {
    files.set(bridgePath, options.initialBridge ?? _internals.buildWslBridgeScript())
  }
  if (options.officialOrcaCommand) {
    files.set(officialCommandPath, options.officialOrcaCommand)
  }
  const calls: string[] = []
  const runner = vi.fn(async (_distro: string, command: string) => {
    calls.push(command)
    if (command.includes('printf %s "$HOME"')) {
      return '/home/alice'
    }
    if (command.includes('case ":$PATH:"')) {
      return pathIncludesLocalBin ? 'yes' : 'no'
    }
    if (command.includes('cat > "$command_tmp"')) {
      if (options.failInstall) {
        throw new Error('simulated replacement failure')
      }
      if (
        files.has(bridgePath) &&
        !files.get(bridgePath)?.includes('# Orca NP managed WSL CLI PowerShell bridge')
      ) {
        throw new Error('__ORCA_CONFLICT__')
      }
      const launcher =
        command.match(/cat > "\$command_tmp" <<'ORCA_WSL_CLI'\n([\s\S]*)\nORCA_WSL_CLI/)?.[1] ?? ''
      const bridge =
        command.match(
          /cat > "\$bridge_tmp" <<'ORCA_WSL_BRIDGE'\n([\s\S]*)\nORCA_WSL_BRIDGE/
        )?.[1] ?? ''
      files.set(commandPath, launcher)
      files.set(bridgePath, bridge)
      return ''
    }
    if (command.includes('command -v powershell.exe')) {
      return options.interopReady === false ? 'no' : 'yes'
    }
    if (command.includes('rm -f')) {
      if (command.includes(`rm -f '${commandPath}'`)) {
        if (
          files.has(bridgePath) &&
          !files.get(bridgePath)?.includes('# Orca NP managed WSL CLI PowerShell bridge')
        ) {
          throw new Error('__ORCA_CONFLICT__')
        }
        files.delete(commandPath)
        files.delete(bridgePath)
      }
      return ''
    }
    if (command.includes('cat ')) {
      if (command.includes(commandPath)) {
        return files.get(commandPath) ?? '__ORCA_MISSING__'
      }
      if (command.includes(bridgePath)) {
        return files.get(bridgePath) ?? '__ORCA_MISSING__'
      }
    }
    throw new Error(`Unexpected WSL command: ${command}`)
  })
  return {
    runner,
    calls,
    getBridge: () => files.get(bridgePath) ?? null,
    getFile: () => files.get(commandPath) ?? null,
    getOfficialCommand: () => files.get(officialCommandPath) ?? null
  }
}

describe('WslCliInstaller', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Why: an official Orca install registers `~/.local/bin/orca-ide` with the same managed marker.
  // Taking that command over is what made each launch undo the other install's registration.
  it('leaves an official install’s orca-ide registration alone', async () => {
    const wsl = createWslRunner(null, true, {
      officialOrcaCommand: OFFICIAL_ORCA_WSL_LAUNCHER
    })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/orca-np'
    })
    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      status: { state: 'not_installed' }
    })
    expect(wsl.getOfficialCommand()).toBe(OFFICIAL_ORCA_WSL_LAUNCHER)
    expect(wsl.calls.some((command) => command.includes('orca-ide'))).toBe(false)
  })

  it('registers the guest command and bridge under this build’s own names', async () => {
    const wsl = createWslRunner()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    const status = await installer.install()
    expect(status).toMatchObject({ state: 'installed', commandName: 'orca-np' })
    expect(status.commandPath).toBe('/home/alice/.local/bin/orca-np')
    const installCommand = wsl.calls.find((command) => command.includes('cat > "$command_tmp"'))
    expect(installCommand).toContain('/home/alice/.local/share/orca-np/orca-wsl-bridge.ps1')
    expect(installCommand).not.toContain('/.local/share/orca/')
  })

  it.skipIf(process.platform === 'win32')(
    'rolls both files back when the command replacement fails after the bridge move',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-rollback-'))
      const home = join(root, 'home with spaces')
      const commandPath = join(home, '.local', 'bin', 'orca-np')
      const bridgePath = join(home, '.local', 'share', 'orca-np', 'orca-wsl-bridge.ps1')
      const bridge = _internals.buildWslBridgeScript()
      await mkdir(join(home, '.local', 'bin'), { recursive: true })
      await mkdir(join(home, '.local', 'share', 'orca-np'), { recursive: true })
      await writeFile(commandPath, PRE_RENAME_MANAGED_WSL_LAUNCHER, 'utf8')
      await writeFile(bridgePath, bridge, 'utf8')

      const runner = async (_distro: string, command: string): Promise<string> => {
        if (command.includes('printf %s "$HOME"')) {
          return home
        }
        if (command.includes('cat > "$command_tmp"')) {
          const executableCommand = command
            .split('\n')
            .map((line) => (line.startsWith('mv -f "$command_tmp" ') ? 'exit 71' : line))
            .join('\n')
          return execFileSync('bash', ['-c', executableCommand], { encoding: 'utf8' })
        }
        if (command.includes('command -v powershell.exe')) {
          return 'yes'
        }
        if (command.includes('case ":$PATH:"')) {
          return 'yes'
        }
        return execFileSync('bash', ['-c', command], { encoding: 'utf8' })
      }
      const installer = new WslCliInstaller({
        platform: 'win32',
        distro: 'Ubuntu',
        hostInstaller: {
          getStatus: async () =>
            makeHostStatus('C:\\Program Files\\Orca\\resources\\bin\\orca-np.exe')
        },
        wslRunner: runner
      })

      try {
        await expect(installer.repairManagedRegistration()).rejects.toThrow()
        await expect(readFile(commandPath, 'utf8')).resolves.toBe(PRE_RENAME_MANAGED_WSL_LAUNCHER)
        await expect(readFile(bridgePath, 'utf8')).resolves.toBe(bridge)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
