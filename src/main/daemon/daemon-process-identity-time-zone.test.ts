import { afterEach, expect, it, vi } from 'vitest'
import { getPsProcessIdentity, getPsProcessIdentityAsync } from './daemon-process-identity-query'

const { execFile, execFileSync } = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile, execFileSync }))

const PS_ARGS = ['-p', '42', '-o', 'lstart=', '-o', 'command=']

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['America/Los_Angeles', 'America/New_York', 'UTC'])(
  'keeps the autumn clock transition unambiguous under %s',
  async (timezone) => {
    vi.stubEnv('TZ', timezone)
    const output = 'Sun Nov  1 09:30:00 2026 /path/to/orca\n'
    execFileSync.mockReturnValue(output)
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, output))
    const expected = {
      startedAtMs: Date.parse('2026-11-01T09:30:00Z'),
      commandLine: '/path/to/orca'
    }

    expect(getPsProcessIdentity(42)).toEqual(expected)
    await expect(getPsProcessIdentityAsync(42)).resolves.toEqual(expected)

    const psOptions = expect.objectContaining({ env: expect.objectContaining({ TZ: 'UTC' }) })
    expect(execFileSync).toHaveBeenCalledWith('ps', PS_ARGS, psOptions)
    expect(execFile).toHaveBeenCalledWith('ps', PS_ARGS, psOptions, expect.any(Function))
    // The async twin must read the same zone and locale as the synchronous one.
    expect(execFile.mock.calls[0][2].env).toEqual(execFileSync.mock.calls[0][2].env)
    if (process.platform === 'darwin') {
      expect(execFile.mock.calls[0][2].env.LC_ALL).toBe('en_US.UTF-8')
    }
  }
)

it('treats an unreadable UTC process start as unknown', () => {
  execFileSync.mockReturnValue('                        /path/to/orca\n')
  expect(getPsProcessIdentity(42)?.startedAtMs).toBeNull()
})
