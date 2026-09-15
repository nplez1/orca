import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { inspectStableCommand } from './cli-command-filesystem-transaction'
import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

// Why simulated rather than staged: macOS enforces a symlink's own permission bits on readlink(2),
// so the real failure needs a root-owned 0700 link — which a test cannot create without root, and
// which a non-root owner can always read anyway. Injecting the denial is the only faithful way in.
const unreadableReadlink = vi.hoisted(() => ({ commandPath: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      if (args[0] === unreadableReadlink.commandPath) {
        throw Object.assign(new Error(`EACCES: permission denied, readlink '${args[0]}'`), {
          code: 'EACCES'
        })
      }
      return actual.readlink(...args)
    }
  }
})

const pendingCleanup: string[] = []

afterEach(async () => {
  unreadableReadlink.commandPath = ''
  await Promise.all(
    pendingCleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function buildStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: '/Applications/Orca.app/Contents/Resources/bin/orca',
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('a managed symlink that cannot be read', () => {
  it('reports stale from status instead of failing the whole call', async () => {
    const fixture = await makeFixture()
    pendingCleanup.push(fixture.root)
    const homePath = join(fixture.root, 'home')
    const resourcesPath = await createPackagedMacLauncher(fixture.root)

    // The dir exists, so this is the canonical macOS command path the installer inspects.
    const binDirectory = join(fixture.root, 'usr', 'local', 'bin')
    await mkdir(binDirectory, { recursive: true })
    const commandPath = join(binDirectory, 'orca')
    await symlink(join(resourcesPath, 'bin', 'orca'), commandPath)
    unreadableReadlink.commandPath = commandPath

    const installer = new CliInstaller({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath,
      userDataPath: fixture.userDataPath,
      execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
      appPath: fixture.appPath,
      homePath,
      defaultMacCommandPath: commandPath,
      processPathEnv: join(homePath, '.local', 'bin')
    })

    const status = await installer.getStatus()

    expect(status.commandPath).toBe(commandPath)
    expect(status.state).toBe('stale')
    // No target evidence is available, so nothing may claim which launcher it points at.
    expect(status.currentTarget).toBeNull()
    expect(status.detail).toContain('cannot be read')
  })

  it('resolves a stable inspection with no target evidence instead of retrying to failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-unreadable-symlink-'))
    pendingCleanup.push(root)
    const commandPath = join(root, 'orca')
    await symlink('/some/other/target', commandPath)
    unreadableReadlink.commandPath = commandPath

    const status = buildStatus({ state: 'stale', currentTarget: null })
    const inspection = await inspectStableCommand(commandPath, async () => status)

    expect(inspection.status).toBe(status)
    expect(inspection.rawSymlinkTarget).toBeNull()
    expect(inspection.fileSha256).toBeNull()
  })
})
