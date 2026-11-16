import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock, nativeSpawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  nativeSpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: spawnMock
}))
// Darwin launches through the native spawn path, so that is where the env is observable there.
vi.mock('@orca/process-host/native-process-spawn', () => ({
  spawnNativeProcess: nativeSpawnMock
}))
vi.mock('@orca/process-host/native-executable-resolution', () => ({
  nativeExecutableResolver: {
    resolveAsync: async (program: string) => ({ program, file: program })
  }
}))

import { gitExecFileAsync } from './command-runner/git-exec-file'
import { gitSpawn } from './command-runner/git-spawn'
import { _resetGitAdmissionForTests } from './command-runner/admission/git-subprocess-admission'
import { _configureLocalLoginShellGitEnvironmentForTests } from './command-runner/local-login-shell-git-environment'

function createMockChildProcess(pid: number) {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid,
    kill: vi.fn()
  })
}

type CaptureOptions = { env?: Record<string, string | undefined> }

/** Whichever launch seam this platform uses: native spawn on darwin, execFile elsewhere. */
function launchOptions(callIndex = 0): CaptureOptions | undefined {
  return nativeSpawnMock.mock.calls[callIndex]?.[2] ?? execFileMock.mock.calls[callIndex]?.[2]
}

/**
 * Why this file exists: a commit or push hook runs inside git's process, so the
 * variables a user exports from ~/.zprofile only reach it if the git child's
 * spawn environment carries them. Asserted at the spawn boundary rather than on
 * the module, because the merge is only useful if the runner hands it to the
 * child.
 */
describe('local login-shell Git environment', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    nativeSpawnMock.mockReset()
    nativeSpawnMock.mockImplementation(() => {
      const child = createMockChildProcess(4321)
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('ok'))
        child.emit('close', 0, null)
      })
      return child
    })
    process.env.PATH = '/hydrated/bin:/usr/bin'
    _configureLocalLoginShellGitEnvironmentForTests(async () => ({
      ORCA_TEST_AGENT_SOCKET: '/tmp/orca-test-agent.sock',
      ORCA_TEST_HOOK_TOKEN: 'from-zprofile',
      PATH: '/profile/bin:/usr/bin'
    }))
  })

  afterEach(() => {
    _resetGitAdmissionForTests()
    _configureLocalLoginShellGitEnvironmentForTests(null)
    delete process.env.ORCA_TEST_HOOK_TOKEN
    delete process.env.ORCA_TEST_AGENT_SOCKET
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('spawns a commit with the exports the login shell would have provided', async () => {
    const child = createMockChildProcess(4322)
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, 'ok', '')
      return child
    })

    await expect(
      gitExecFileAsync(['commit', '-m', 'message'], { cwd: process.cwd() })
    ).resolves.toEqual({ stdout: 'ok', stderr: '' })

    const env = launchOptions()?.env
    expect(env?.ORCA_TEST_HOOK_TOKEN).toBe('from-zprofile')
    expect(env?.ORCA_TEST_AGENT_SOCKET).toBe('/tmp/orca-test-agent.sock')
    // Why: the hydrated PATH is Orca's own value, so the shell's must not replace it.
    expect(env?.PATH).toBe('/hydrated/bin:/usr/bin')
  })

  it('spawns a sync git with the same environment once the probe has settled', async () => {
    const child = createMockChildProcess(4323)
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, 'ok', '')
      return child
    })
    spawnMock.mockReturnValue(child)

    await gitExecFileAsync(['commit', '-m', 'message'], { cwd: process.cwd() })
    gitSpawn(['status'], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] })

    // Why: the sync path cannot await the probe, so it must reuse the settled one.
    const env = nativeSpawnMock.mock.calls.at(-1)?.[2]?.env
    expect(env?.ORCA_TEST_HOOK_TOKEN).toBe('from-zprofile')
    expect(env?.PATH).toBe('/hydrated/bin:/usr/bin')
  })
})
