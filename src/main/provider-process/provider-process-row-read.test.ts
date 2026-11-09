import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUtcLstart } from '../../shared/ps-lstart-time'
import { parseLinuxProcStat, readPosixProcessRow } from './provider-process-row-read'

describe('parseLinuxProcStat', () => {
  it('reads parent, group and start ticks past a comm with spaces and parentheses', () => {
    const fields = ['S', '41', '4242', '4242', ...Array<string>(15).fill('0'), '987654', '0']
    expect(parseLinuxProcStat(4242, `4242 (open (code) serve) ${fields.join(' ')}`)).toEqual({
      pid: 4242,
      ppid: 41,
      pgid: 4242,
      startedAt: 'clock-tick:987654',
      startResolution: 'clock-tick'
    })
  })
})

describe.runIf(process.platform !== 'win32')('readPosixProcessRow', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads this process with the same start marker every time', async () => {
    const first = await readPosixProcessRow(process.pid)
    const second = await readPosixProcessRow(process.pid)
    expect(first).toMatchObject({ pid: process.pid, ppid: process.ppid })
    expect(second).toEqual(first)
  })

  it.runIf(process.platform === 'darwin')(
    'reads a start marker in the zone the second-boundary proof parses',
    async () => {
      vi.stubEnv('TZ', 'America/Los_Angeles')
      const row = await readPosixProcessRow(process.pid)
      if (row === null || row === 'unverifiable') {
        throw new Error('this process could not be read')
      }

      const startedAtMs = parseUtcLstart(row.startedAt)
      // ast-grep-ignore: test-no-wall-clock -- the real clock is the point: the assertion checks the row's start time against this process's actual uptime.
      expect(Math.abs(startedAtMs - (Date.now() - process.uptime() * 1_000))).toBeLessThan(60_000)
    }
  )

  it('reports a pid with no process as absent, not unverifiable', async () => {
    await expect(readPosixProcessRow(2 ** 22 + 12_345)).resolves.toBeNull()
  })
})
