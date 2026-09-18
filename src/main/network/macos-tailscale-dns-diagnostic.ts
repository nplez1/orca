import { runProcess } from '../../shared/child-process/run-process'

const TAILSCALE_MAGIC_DNS = '100.100.100.100'
const CACHE_TTL_MS = 5 * 60 * 1000
const SCUTIL_PROBE_TIMEOUT_MS = 1500
const SCUTIL_MAX_OUTPUT_BYTES = 64 * 1024

type DnsDiagnostic = {
  globalNameservers: string[]
}

type CacheEntry = {
  expiresAt: number
  diagnostic: DnsDiagnostic | null
}

let cache: CacheEntry | null = null
let inFlightProbe: Promise<void> | null = null

const NETWORK_LOOKUP_FAILURE_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ESERVFAIL|ERR_NAME_NOT_RESOLVED)\b|lookup address|nodename nor servname|name resolution|dns|websocket|connection refused/i

function globalDnsSection(scutilOutput: string): string {
  const scopedStart = scutilOutput.indexOf('\nDNS configuration (for scoped queries)')
  return scopedStart !== -1 ? scutilOutput.slice(0, scopedStart) : scutilOutput
}

export function parseMacTailscaleDnsDiagnostic(scutilOutput: string): DnsDiagnostic | null {
  const globalSection = globalDnsSection(scutilOutput)
  const nameservers = [
    ...new Set(
      Array.from(globalSection.matchAll(/nameserver\[\d+\]\s*:\s*([^\s]+)/g), (match) =>
        match[1].trim()
      )
    )
  ]

  if (nameservers.length === 0) {
    return null
  }
  if (!nameservers.every((nameserver) => nameserver === TAILSCALE_MAGIC_DNS)) {
    return null
  }

  return { globalNameservers: nameservers }
}

/**
 * Refresh the cached resolver probe without blocking the caller.
 *
 * Why the probe is never synchronous: `scutil --dns` can stall for its whole timeout when
 * configd is wedged, and this path only runs after a request already failed, so a blocking
 * probe stacked a second stall on top of the failure it was there to explain. Readers keep
 * the synchronous hint API and serve the last completed probe; the hint therefore lands on
 * the next lookup failure rather than the one that triggered the probe, unless the cache was
 * primed first (see primeMacTailscaleDnsDiagnostic).
 */
function beginMacTailscaleDnsDiagnosticProbe(): Promise<void> {
  if (inFlightProbe) {
    return inFlightProbe
  }
  inFlightProbe = runProcess({
    program: '/usr/sbin/scutil',
    args: ['--dns'],
    timeoutMs: SCUTIL_PROBE_TIMEOUT_MS,
    maxOutputBytes: SCUTIL_MAX_OUTPUT_BYTES
  })
    .then((result) => {
      // Why: only a clean exit carries a real resolver list; a killed or failed probe must
      // read as "no diagnostic" rather than as a partial configuration.
      cache = {
        diagnostic:
          result.code === 0 && !result.timedOut
            ? parseMacTailscaleDnsDiagnostic(result.stdout)
            : null,
        expiresAt: Date.now() + CACHE_TTL_MS
      }
    })
    .catch(() => {
      cache = { diagnostic: null, expiresAt: Date.now() + CACHE_TTL_MS }
    })
    .finally(() => {
      inFlightProbe = null
    })
  return inFlightProbe
}

/** Warm the cache off the main thread so the first failed request can still carry the hint. */
export function primeMacTailscaleDnsDiagnostic(): Promise<void> {
  return process.platform === 'darwin' ? beginMacTailscaleDnsDiagnosticProbe() : Promise.resolve()
}

export function readMacTailscaleDnsDiagnostic(now = Date.now()): DnsDiagnostic | null {
  if (process.platform !== 'darwin') {
    return null
  }
  // Why stale-while-revalidate: the resolver layout changes at network-transition cadence, not
  // per request, so serving the previous answer beats blocking for a fresher one.
  if (!cache || cache.expiresAt <= now) {
    void beginMacTailscaleDnsDiagnosticProbe()
  }
  return cache?.diagnostic ?? null
}

export function withMacTailscaleDnsHintForDiagnostic(
  message: string,
  detail: string | null | undefined,
  diagnostic: DnsDiagnostic | null
): string {
  const probeText = `${message}\n${detail ?? ''}`
  if (!NETWORK_LOOKUP_FAILURE_RE.test(probeText)) {
    return message
  }
  if (!diagnostic) {
    return message
  }

  // Why: Claude/Codex own the failing API transports, so Orca can only point
  // users at the macOS resolver configuration that makes those transports fail.
  return `${message} macOS is using Tailscale MagicDNS (100.100.100.100) as the only global DNS resolver; add an upstream DNS server to the active network service or configure Tailscale global nameservers, then retry.`
}

export function withMacTailscaleDnsHint(message: string, detail?: string | null): string {
  return withMacTailscaleDnsHintForDiagnostic(message, detail, readMacTailscaleDnsDiagnostic())
}

export function __resetMacTailscaleDnsDiagnosticCacheForTests(): void {
  cache = null
  inFlightProbe = null
}
