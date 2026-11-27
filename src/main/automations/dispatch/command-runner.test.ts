import { describe, expect, it } from 'vitest'
import { runHostCommand, type HostCommandRun } from './command-runner'

const commandRun = (command: string, overrides: Partial<HostCommandRun> = {}): HostCommandRun => ({
  command: { command, timeoutSeconds: 5 },
  shell: 'plain',
  label: 'Command',
  killSite: 'automation-command-timeout',
  ...overrides
})

describe('runHostCommand', () => {
  it('captures stdout and a zero exit', async () => {
    const result = await runHostCommand(commandRun('printf hello'), {
      type: 'local',
      cwd: process.cwd()
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello', timedOut: false, error: null })
  })

  it('keeps the exit code and stderr of a failed command', async () => {
    const result = await runHostCommand(commandRun('echo broken >&2; exit 3'), {
      type: 'local',
      cwd: process.cwd()
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.trim()).toBe('broken')
    expect(result.timedOut).toBe(false)
    expect(result.error).toBeNull()
  })

  it('reports a timeout in the label that ran it', async () => {
    const result = await runHostCommand(commandRun('sleep 5', {
      command: { command: 'sleep 5', timeoutSeconds: 1 }
    }), { type: 'local', cwd: process.cwd() })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.error).toBe('Command timed out after 1s.')
    expect(result.durationMs).toBeLessThan(4_000)
  })

  it('refuses an SSH target that is not connected', async () => {
    const result = await runHostCommand(commandRun('printf hello'), {
      type: 'ssh',
      cwd: '/tmp',
      connectionId: 'no-such-connection'
    })
    expect(result).toMatchObject({ exitCode: null, error: 'SSH target is not connected.' })
  })
})
