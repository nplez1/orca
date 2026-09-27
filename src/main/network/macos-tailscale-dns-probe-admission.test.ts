import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { formatAgentCliFailureMessage } from '../text-generation/source-control-agent-failure'
import {
  __resetMacTailscaleDnsDiagnosticCacheForTests,
  parseMacTailscaleDnsDiagnostic,
  primeMacTailscaleDnsDiagnostic,
  withMacTailscaleDnsHint,
  withMacTailscaleDnsHintForDiagnostic
} from './macos-tailscale-dns-diagnostic'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const MAGIC_DNS = 'DNS configuration\n  nameserver[0] : 100.100.100.100\n'
const PUBLIC_DNS = 'DNS configuration\n  nameserver[0] : 1.1.1.1\n'

function scutilResult(
  stdout: string,
  overrides: Partial<{ code: number | null; timedOut: boolean }> = {}
): { code: number | null; signal: null; stdout: string; stderr: string; timedOut: boolean } {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...overrides }
}

/**
 * Why the prime step: this fork serves the last completed resolver probe so a DNS-ish request
 * failure never blocks the main thread on `scutil` (see macos-tailscale-dns-diagnostic.ts).
 * A test that asserts the hint must prime the cache first; the probe then must not re-run
 * inside the five-minute window.
 */
async function primeWith(stdout: string): Promise<void> {
  vi.mocked(runProcess).mockResolvedValue(scutilResult(stdout))
  await primeMacTailscaleDnsDiagnostic()
  vi.mocked(runProcess).mockClear()
}

async function primeFailed(): Promise<void> {
  vi.mocked(runProcess).mockRejectedValue(new Error('probe failed'))
  await primeMacTailscaleDnsDiagnostic()
  vi.mocked(runProcess).mockClear()
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  vi.mocked(runProcess).mockReset().mockResolvedValue(scutilResult(MAGIC_DNS))
  __resetMacTailscaleDnsDiagnosticCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetMacTailscaleDnsDiagnosticCacheForTests()
})

describe('macOS DNS probe admission', () => {
  it.each(['permission denied', 'authentication failed', 'PTY timeout', '', 'invalid JSON'])(
    'does not probe for an unrelated error: %s',
    (detail) => {
      expect(withMacTailscaleDnsHint('Codex failed.', detail)).toBe('Codex failed.')
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it.each([
    'ENOTFOUND',
    'eai_again',
    'lookup address',
    'DNS failure',
    'websocket',
    'connection refused'
  ])('still diagnoses a relevant detail: %s', async (detail) => {
    await primeWith(MAGIC_DNS)
    expect(withMacTailscaleDnsHint('Codex failed.', detail)).toContain('Tailscale MagicDNS')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('recognizes a relevant message without detail', async () => {
    await primeWith(MAGIC_DNS)
    expect(withMacTailscaleDnsHint('ERR_NAME_NOT_RESOLVED')).toContain('Tailscale MagicDNS')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'] as const)('never probes on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('does not warm the diagnostic cache for an unrelated failure', () => {
    expect(withMacTailscaleDnsHint('permission denied')).toBe('permission denied')
    expect(runProcess).not.toHaveBeenCalled()

    // A relevant failure on a cold cache starts the background probe and answers unhinted;
    // the hint lands on the next lookup failure.
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
    expect(runProcess).toHaveBeenCalledOnce()
  })

  it('reuses the sample inside the five-minute window and refreshes it after', async () => {
    await primeWith(MAGIC_DNS)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    expect(runProcess).not.toHaveBeenCalled()

    vi.mocked(Date.now).mockReturnValue(300_999)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    expect(runProcess).not.toHaveBeenCalled()

    vi.mocked(Date.now).mockReturnValue(301_000)
    vi.mocked(runProcess).mockResolvedValue(scutilResult(PUBLIC_DNS))
    // The expired window still serves the completed sample to this caller while a refresh runs.
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    expect(runProcess).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(withMacTailscaleDnsHint('EAI_AGAIN')).toBe('EAI_AGAIN'))
  })

  it.each(['empty output', 'failed command'])(
    'retains negative caching for %s',
    async (failure) => {
      await (failure === 'failed command' ? primeFailed() : primeWith(''))
      expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
      expect(withMacTailscaleDnsHint('EAI_AGAIN')).toBe('EAI_AGAIN')
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it.each([
    'EAI_NONAME',
    'EAI_FAIL',
    'ENODATA',
    'getaddrinfo failed',
    'could not resolve host orca.example',
    'Name or service not known',
    'ERR_NAME_RESOLUTION_FAILED',
    'Temporary failure in name resolution'
  ])('diagnoses the resolution failure wording %s', async (detail) => {
    await primeWith(MAGIC_DNS)
    expect(withMacTailscaleDnsHint('Codex failed.', detail)).toContain('Tailscale MagicDNS')
  })

  it('never lets probe admission change the message the hint decision would produce', async () => {
    await primeWith(MAGIC_DNS)
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS)
    const details = [
      'permission denied',
      'authentication failed',
      'PTY timeout',
      'invalid JSON',
      '',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EAI_NONAME',
      'getaddrinfo failed',
      'could not resolve host orca.example',
      'connection refused',
      'websocket closed'
    ]

    for (const detail of details) {
      expect(withMacTailscaleDnsHint('Codex failed.', detail)).toBe(
        withMacTailscaleDnsHintForDiagnostic('Codex failed.', detail, diagnostic)
      )
    }
  })

  it('does not append or re-probe for a message that already carries the hint', async () => {
    await primeWith(MAGIC_DNS)
    const hinted = withMacTailscaleDnsHint('Codex failed.', 'ENOTFOUND')
    expect(hinted).toContain('Tailscale MagicDNS')
    expect(runProcess).not.toHaveBeenCalled()
    // Past the cache window, so a second probe would run if the hint were re-admitted.
    vi.mocked(Date.now).mockReturnValue(301_000)

    expect(withMacTailscaleDnsHint(hinted, 'ENOTFOUND')).toBe(hinted)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('avoids probing while formatting a local CLI permission failure', () => {
    expect(formatAgentCliFailureMessage('Codex', '', 'permission denied', 1)).toBe(
      'Codex CLI command failed with code 1: permission denied'
    )
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('keeps local network hints and honors the remote host opt-out', async () => {
    await primeWith(MAGIC_DNS)
    expect(
      formatAgentCliFailureMessage('Codex', '', 'ENOTFOUND', 1, { includeLocalMacDnsHint: false })
    ).toBe('Codex CLI command failed with code 1: ENOTFOUND')
    expect(runProcess).not.toHaveBeenCalled()
    expect(formatAgentCliFailureMessage('Codex', '', 'ENOTFOUND', 1)).toContain(
      'Tailscale MagicDNS'
    )
    expect(runProcess).not.toHaveBeenCalled()
  })
})
