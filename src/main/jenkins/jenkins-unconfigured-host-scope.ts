import { lookup } from 'node:dns/promises'

/**
 * Whether a Jenkins build URL that matched no configured server may be fetched at all.
 *
 * Why this exists: the URL comes from a commit status, which anyone with write access to the repo
 * can post. A link shaped like a Jenkins build makes the desktop issue a blind GET, so an
 * unconfigured host that only resolves inside a corporate network or on `localhost` is a way to
 * probe this machine's intranet from outside. No credentials travel on such a request, so the risk
 * is the probe itself rather than exfiltration — which is why the answer is "do not send it".
 *
 * Two checks: the literal address, and the addresses the name resolves to here — a split-horizon
 * name is the ordinary intranet setup, and no literal test can see it. A name this machine cannot
 * resolve is refused rather than allowed, because the transport resolves it again and an attacker's
 * own DNS can fail the first answer (TTL 0) and hand the second one a private address.
 *
 * Known residual, and why it is stated rather than closed: the name is resolved twice, so a
 * rebinding name that answers public first and private second gets through. Pinning the vetted
 * address into the request is not possible through `net.fetch`, and refusing every unconfigured
 * host outright is the other half of the issue's advice — not what this fork chose.
 */

/** Suffixes that are private by construction (RFC 6762 `.local`, RFC 8375 `.home.arpa`). */
const PRIVATE_HOST_SUFFIXES = [
  '.internal',
  '.intranet',
  '.corp',
  '.lan',
  '.local',
  '.localdomain',
  '.home',
  '.home.arpa',
  '.localhost',
  '.test',
  '.invalid',
  '.example'
]

/** Resolved addresses for a host name, or null when this machine cannot resolve it. */
export type HostAddressLookup = (hostname: string) => Promise<readonly string[] | null>

/** A resolver that hangs must not hold the Checks pane open past the request timeout. */
const LOOKUP_TIMEOUT_MS = 2_000

async function lookupHostAddresses(hostname: string): Promise<readonly string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)
  })
  try {
    // `dns.lookup` cannot be cancelled, so the abandoned promise is raced rather than aborted.
    const answers = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout])
    return answers?.map((entry) => entry.address) ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function isIpv4InRange(octets: readonly number[], start: readonly number[], bits: number): boolean {
  let remaining = bits
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const take = Math.min(8, remaining)
    const mask = (0xff << (8 - take)) & 0xff
    if ((octets[index] & mask) !== (start[index] & mask)) {
      return false
    }
    remaining -= take
  }
  return true
}

const PRIVATE_IPV4_RANGES: readonly { start: readonly number[]; bits: number }[] = [
  { start: [0, 0, 0, 0], bits: 8 },
  { start: [10, 0, 0, 0], bits: 8 },
  { start: [100, 64, 0, 0], bits: 10 },
  { start: [127, 0, 0, 0], bits: 8 },
  { start: [169, 254, 0, 0], bits: 16 },
  { start: [172, 16, 0, 0], bits: 12 },
  { start: [192, 0, 0, 0], bits: 24 },
  { start: [192, 168, 0, 0], bits: 16 },
  { start: [198, 18, 0, 0], bits: 15 },
  { start: [198, 51, 100, 0], bits: 24 },
  { start: [203, 0, 113, 0], bits: 24 },
  { start: [224, 0, 0, 0], bits: 4 },
  { start: [240, 0, 0, 0], bits: 4 }
]

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false
  }
  return PRIVATE_IPV4_RANGES.some((range) => isIpv4InRange(octets, range.start, range.bits))
}

function stripAddressBrackets(host: string): string {
  return host
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase()
}

/**
 * The IPv4 address an IPv4-mapped IPv6 literal carries.
 *
 * Why both spellings: `new URL('http://[::ffff:127.0.0.1]/')` re-serializes its hostname as
 * `[::ffff:7f00:1]`, so the dotted form never reaches this module from the URL parser — but it does
 * from a DNS answer.
 */
function mappedIpv4(address: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (dotted) {
    return dotted[1]
  }
  const groups = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (!groups) {
    return null
  }
  const high = Number.parseInt(groups[1], 16)
  const low = Number.parseInt(groups[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isPrivateIpv6(host: string): boolean {
  const address = stripAddressBrackets(host)
  const mapped = mappedIpv4(address)
  if (mapped) {
    return isPrivateIpv4(mapped)
  }
  if (address === '::' || address === '::1') {
    return true
  }
  // The first group decides both ranges, and comparing it as a number keeps `fc::` and `fe8::`
  // public — a prefix regex over the text would swallow them.
  const firstGroup = /^([0-9a-f]{1,4})(?::|$)/.exec(address)?.[1]
  if (!firstGroup) {
    return false
  }
  const first = Number.parseInt(firstGroup, 16)
  // fc00::/7 unique-local, fe80::/10 link-local.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

function isIpLiteral(host: string): boolean {
  return /\d/.test(host) && (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':'))
}

/** A single-label name (`http://jenkins/…`) is an intranet host, never a public Jenkins. */
function isSingleLabelHost(host: string): boolean {
  return !host.includes('.') && !host.includes(':')
}

/** Whether the address itself is one only this machine or its network can reach. */
export function isPrivateJenkinsHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  if (normalized.length === 0 || normalized === 'localhost') {
    return true
  }
  if (isSingleLabelHost(normalized)) {
    return true
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true
  }
  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized)
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Whether this URL may be requested without a configured server.
 *
 * Unconfigured public Jenkins is a supported case — an open-source project's build link renders
 * with no setup — so this refuses only what cannot be that: a private literal, a private name, or a
 * name that resolves to an address only this network can reach.
 */
export async function isPubliclyRoutableUrl(
  url: string,
  lookupAddresses: HostAddressLookup = lookupHostAddresses
): Promise<boolean> {
  const parsed = parseHttpUrl(url)
  if (!parsed) {
    return false
  }
  const hostname = parsed.hostname
  if (isPrivateJenkinsHost(hostname)) {
    return false
  }
  if (isIpLiteral(stripAddressBrackets(hostname))) {
    // Already judged above; a literal has nothing left to resolve.
    return true
  }
  const addresses = await lookupAddresses(stripAddressBrackets(hostname))
  if (addresses === null) {
    return false
  }
  return addresses.every((address) => !isPrivateJenkinsHost(address))
}
