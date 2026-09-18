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

// Symbolic errno/Chromium codes carry the weight because they are locale-independent; the
// English phrases only add coverage, so a localized or reworded string costs the hint, never
// a wrong message. Deliberately over-inclusive: a false candidate re-reads cached DNS state,
// a missed one silently drops the diagnostic that explains a broken connection.
const NETWORK_LOOKUP_FAILURE_RE =
  /\b(?:ENOTFOUND|ENODATA|EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME|ESERVFAIL|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|getaddrinfo)\b|lookup address|nodename nor servname|name resolution|name or service not known|no address associated with hostname|(?:could not|couldn't|cannot|can't|unable to|failed to) resolve|dns|websocket|connection refused/i

const MAGIC_DNS_HINT =
  'macOS is using Tailscale MagicDNS (100.100.100.100) as the only global DNS resolver; add an upstream DNS server to the active network service or configure Tailscale global nameservers, then retry.'

/**
 * Single source of truth for "could a DNS sample explain this failure?". The probe-admission
 * gate and the hint decision must never disagree — a gate stricter than the hint test silently
 * loses the diagnostic for a genuine DNS failure.
 */
export function isMacTailscaleDnsHintCandidate(message: string, detail?: string | null): boolean {
  // Already hinted: re-wrapping a hinted message would match on its own "DNS" text.
  if (message.endsWith(MAGIC_DNS_HINT)) {
    return false
  }
  return NETWORK_LOOKUP_FAILURE_RE.test(`${message}\n${detail ?? ''}`)
}

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

// Why: Claude/Codex own the failing API transports, so Orca can only point
// users at the macOS resolver configuration that makes those transports fail.
function appendMagicDnsHint(message: string, diagnostic: DnsDiagnostic | null): string {
  return diagnostic ? `${message} ${MAGIC_DNS_HINT}` : message
}

export function withMacTailscaleDnsHintForDiagnostic(
  message: string,
  detail: string | null | undefined,
  diagnostic: DnsDiagnostic | null
): string {
  return isMacTailscaleDnsHintCandidate(message, detail)
    ? appendMagicDnsHint(message, diagnostic)
    : message
}

export function withMacTailscaleDnsHint(message: string, detail?: string | null): string {
  // The hint only describes macOS resolver state, so nothing off darwin can produce it.
  if (process.platform !== 'darwin') {
    return message
  }
  if (!isMacTailscaleDnsHintCandidate(message, detail)) {
    return message
  }
  return appendMagicDnsHint(message, readMacTailscaleDnsDiagnostic())
}

export function __resetMacTailscaleDnsDiagnosticCacheForTests(): void {
  cache = null
  inFlightProbe = null
}
