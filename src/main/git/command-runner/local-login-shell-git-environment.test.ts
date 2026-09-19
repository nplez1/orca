import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _configureLocalLoginShellGitEnvironmentForTests,
  configureLocalLoginShellGitEnvironment,
  localLoginShellGitEnvironmentSnapshot,
  prepareLocalLoginShellGitEnvironment
} from './local-login-shell-git-environment'
import type { ResolvedCommand } from './wsl-command-resolution'

const SHELL_SENTINEL = 'ORCA_TEST_SHELL_STARTUP_ENV'
const LAUNCH_SENTINEL = 'ORCA_TEST_LAUNCH_ENV'

function localCommand(): ResolvedCommand {
  return { binary: 'git', args: ['status'], cwd: '/repo', wsl: null, wslMode: null }
}

function wslCommand(): ResolvedCommand {
  return {
    binary: 'wsl.exe',
    args: ['-d', 'Ubuntu'],
    cwd: undefined,
    wsl: { distro: 'Ubuntu', linuxPath: '/home/me/repo' },
    wslMode: 'login-shell'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('local login-shell Git environment', () => {
  afterEach(() => {
    _configureLocalLoginShellGitEnvironmentForTests(null)
    delete process.env[SHELL_SENTINEL]
    delete process.env[LAUNCH_SENTINEL]
  })

  it('is inert until a host enables it', () => {
    expect(prepareLocalLoginShellGitEnvironment(localCommand(), undefined)).toBeNull()
    expect(localLoginShellGitEnvironmentSnapshot({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('stays inert on Windows, which inherits the user registry environment', async () => {
    await withPlatform('win32', async () => {
      const resolver = vi.fn(async () => ({ [SHELL_SENTINEL]: 'shell' }))
      _configureLocalLoginShellGitEnvironmentForTests(resolver)

      expect(prepareLocalLoginShellGitEnvironment(localCommand(), undefined)).toBeNull()
      expect(localLoginShellGitEnvironmentSnapshot({ PATH: 'C:\\bin' })).toEqual({
        PATH: 'C:\\bin'
      })
      expect(resolver).not.toHaveBeenCalled()
    })
  })

  it('does not enable the probe on Windows', async () => {
    await withPlatform('win32', async () => {
      configureLocalLoginShellGitEnvironment()

      expect(prepareLocalLoginShellGitEnvironment(localCommand(), undefined)).toBeNull()
    })
  })

  it('does not apply a Windows-side profile to a WSL-routed command', () => {
    const resolver = vi.fn(async () => ({ [SHELL_SENTINEL]: 'shell' }))
    _configureLocalLoginShellGitEnvironmentForTests(resolver)

    expect(prepareLocalLoginShellGitEnvironment(wslCommand(), undefined)).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('fills in the profile export the launch environment dropped', async () => {
    _configureLocalLoginShellGitEnvironmentForTests(async () => ({
      [SHELL_SENTINEL]: 'from-zprofile',
      SSH_AUTH_SOCK: '/tmp/agent.sock'
    }))

    await expect(
      prepareLocalLoginShellGitEnvironment(localCommand(), { PATH: '/orca/bin' })
    ).resolves.toEqual({
      PATH: '/orca/bin',
      [SHELL_SENTINEL]: 'from-zprofile',
      SSH_AUTH_SOCK: '/tmp/agent.sock'
    })
  })

  it('never lets the shell outrank a value the launch environment already has', async () => {
    process.env[LAUNCH_SENTINEL] = 'launch-value'
    _configureLocalLoginShellGitEnvironmentForTests(async () => ({
      [LAUNCH_SENTINEL]: 'shell-value',
      [SHELL_SENTINEL]: 'shell-only'
    }))

    await expect(prepareLocalLoginShellGitEnvironment(localCommand(), undefined)).resolves.toEqual(
      expect.objectContaining({
        [LAUNCH_SENTINEL]: 'launch-value',
        [SHELL_SENTINEL]: 'shell-only'
      })
    )
  })

  it('spawns the profile-loading shell once per process', async () => {
    const resolver = vi.fn(async () => ({ [SHELL_SENTINEL]: 'shell' }))
    _configureLocalLoginShellGitEnvironmentForTests(resolver)

    await prepareLocalLoginShellGitEnvironment(localCommand(), {})
    await prepareLocalLoginShellGitEnvironment(localCommand(), {})
    await prepareLocalLoginShellGitEnvironment(localCommand(), {})

    expect(resolver).toHaveBeenCalledOnce()
  })

  it('degrades to the launch environment when the probe fails', async () => {
    process.env[LAUNCH_SENTINEL] = 'launch-value'
    _configureLocalLoginShellGitEnvironmentForTests(() => {
      throw new Error('shell vanished mid-session')
    })

    await expect(prepareLocalLoginShellGitEnvironment(localCommand(), undefined)).resolves.toEqual(
      expect.objectContaining({ [LAUNCH_SENTINEL]: 'launch-value' })
    )
  })

  it('rejects a cancelled command without spawning on the probe', async () => {
    const probe = deferred<NodeJS.ProcessEnv>()
    _configureLocalLoginShellGitEnvironmentForTests(() => probe.promise)
    const controller = new AbortController()

    const prepared = prepareLocalLoginShellGitEnvironment(localCommand(), {}, controller.signal)
    controller.abort()

    await expect(prepared).rejects.toMatchObject({ name: 'AbortError' })
    probe.resolve({ [SHELL_SENTINEL]: 'shell' })
  })

  it('gives a sync spawn path the environment once the probe has settled', async () => {
    _configureLocalLoginShellGitEnvironmentForTests(async () => ({
      SSH_AUTH_SOCK: '/tmp/agent.sock'
    }))

    expect(localLoginShellGitEnvironmentSnapshot({ PATH: '/bin' })).toEqual({ PATH: '/bin' })

    await prepareLocalLoginShellGitEnvironment(localCommand(), {})

    expect(localLoginShellGitEnvironmentSnapshot({ PATH: '/bin' })).toEqual({
      PATH: '/bin',
      SSH_AUTH_SOCK: '/tmp/agent.sock'
    })
  })
})
