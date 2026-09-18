import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  __resetMacTailscaleDnsDiagnosticCacheForTests,
  parseMacTailscaleDnsDiagnostic,
  primeMacTailscaleDnsDiagnostic,
  readMacTailscaleDnsDiagnostic,
  withMacTailscaleDnsHint,
  withMacTailscaleDnsHintForDiagnostic
} from './macos-tailscale-dns-diagnostic'

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn()
}))

const MAGIC_DNS_ONLY_SCUTIL = `
DNS configuration

resolver #1
  nameserver[0] : 100.100.100.100
  flags    : Request A records
  reach    : 0x00000002 (Reachable)
  order    : 5000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.1.1
  if_index : 14 (en0)
`

function scutilResult(
  stdout: string,
  overrides: Partial<{ code: number | null; timedOut: boolean }> = {}
): {
  code: number | null
  signal: null
  stdout: string
  stderr: string
  timedOut: boolean
} {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...overrides }
}

describe('parseMacTailscaleDnsDiagnostic', () => {
  it('detects Tailscale MagicDNS as the only global resolver', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)

    expect(diagnostic).toEqual({ globalNameservers: ['100.100.100.100'] })
  })

  it('ignores configurations with non-Tailscale global resolvers', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(`
DNS configuration

resolver #1
  nameserver[0] : 100.100.100.100
  nameserver[1] : 1.1.1.1
  order    : 5000
`)

    expect(diagnostic).toBeNull()
  })

  it('does not treat scoped-only Tailscale resolvers as the global failure shape', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(`
DNS configuration

resolver #1
  nameserver[0] : 192.168.1.1
  order    : 5000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 100.100.100.100
  if_index : 19 (utun7)
`)

    expect(diagnostic).toBeNull()
  })
})

describe('withMacTailscaleDnsHintForDiagnostic', () => {
  it('adds a Tailscale DNS hint for the Codex lookup failure from the issue', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)
    const result = withMacTailscaleDnsHintForDiagnostic(
      'Codex failed. Check the agent CLI configuration and try again.',
      'stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known',
      diagnostic
    )

    expect(result).toContain('Tailscale MagicDNS (100.100.100.100)')
    expect(result).toContain('add an upstream DNS server')
  })

  it('leaves unrelated failures unchanged even under MagicDNS-only DNS', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)
    const message = 'Codex failed. Check the agent CLI configuration and try again.'

    expect(withMacTailscaleDnsHintForDiagnostic(message, 'permission denied', diagnostic)).toBe(
      message
    )
  })
})

describe('macOS resolver probe', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.mocked(runProcess).mockReset()
    __resetMacTailscaleDnsDiagnosticCacheForTests()
  })

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  it('reads macOS DNS state through the system scutil path', async () => {
    setPlatform('darwin')
    vi.mocked(runProcess).mockResolvedValue(scutilResult(MAGIC_DNS_ONLY_SCUTIL))

    await primeMacTailscaleDnsDiagnostic()

    expect(runProcess).toHaveBeenCalledWith({
      program: '/usr/sbin/scutil',
      args: ['--dns'],
      timeoutMs: 1500,
      maxOutputBytes: 64 * 1024
    })
    expect(withMacTailscaleDnsHint('Codex failed.', 'dns lookup failed')).toContain(
      'Tailscale MagicDNS (100.100.100.100)'
    )
  })

  it('never blocks a reader on the probe', () => {
    setPlatform('darwin')
    vi.mocked(runProcess).mockResolvedValue(scutilResult(MAGIC_DNS_ONLY_SCUTIL))

    // Why: a cold cache must answer immediately; the hint arrives on a later failure.
    expect(readMacTailscaleDnsDiagnostic()).toBeNull()
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('shares one probe between concurrent readers and refreshes once per window', async () => {
    setPlatform('darwin')
    const pending: { resolve: ((value: ReturnType<typeof scutilResult>) => void) | null } = {
      resolve: null
    }
    vi.mocked(runProcess).mockReturnValue(
      new Promise((resolve) => {
        pending.resolve = resolve
      })
    )

    readMacTailscaleDnsDiagnostic()
    readMacTailscaleDnsDiagnostic()
    expect(runProcess).toHaveBeenCalledTimes(1)

    pending.resolve?.(scutilResult(MAGIC_DNS_ONLY_SCUTIL))
    await vi.waitFor(() => {
      expect(readMacTailscaleDnsDiagnostic(0)).toEqual({
        globalNameservers: ['100.100.100.100']
      })
    })
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('degrades a timed-out probe to no diagnostic', async () => {
    setPlatform('darwin')
    vi.mocked(runProcess).mockResolvedValue(
      scutilResult(MAGIC_DNS_ONLY_SCUTIL, { code: null, timedOut: true })
    )

    await primeMacTailscaleDnsDiagnostic()

    expect(withMacTailscaleDnsHint('Codex failed.', 'dns lookup failed')).toBe('Codex failed.')
  })

  it('spawns nothing off macOS', async () => {
    setPlatform('linux')

    await primeMacTailscaleDnsDiagnostic()

    expect(runProcess).not.toHaveBeenCalled()
    expect(readMacTailscaleDnsDiagnostic()).toBeNull()
  })
})
