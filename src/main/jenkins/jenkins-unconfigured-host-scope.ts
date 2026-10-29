/**
 * Whether a Jenkins build URL that matched no configured server may be fetched at all.
 *
 * Why this exists: the URL comes from a commit status, which anyone with write access to the repo
 * can post. A link shaped like a Jenkins build makes the desktop issue a blind GET, so an
 * unconfigured host that only resolves inside a corporate network or on `localhost` is a way to
 * probe this machine's intranet from outside. No credentials travel on such a request, so the risk
 * is the probe itself rather than exfiltration — which is why the answer is "do not send it".
 *
 * Only literal addresses are judged. Resolving a name first would repeat the very request this
 * check exists to avoid, and a name that resolves into a private range is covered by the
 * single-label and private-suffix rules below.
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

function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase()
  // An IPv4-mapped address is private when the address it carries is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) {
    return isPrivateIpv4(mapped[1])
  }
  if (address === '::' || address === '::1') {
    return true
  }
  // fc00::/7 unique-local and fe80::/10 link-local cover the intranet cases.
  return /^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address)
}

/** A single-label name (`http://jenkins/…`) is an intranet host, never a public Jenkins. */
function isSingleLabelHost(host: string): boolean {
  return !host.includes('.') && !host.includes(':')
}

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

/**
 * Whether a build URL may be read without a configured server.
 *
 * Unconfigured public Jenkins is a supported case — an open-source project's build link renders
 * with no setup — so this only refuses the hosts that cannot be that.
 */
export function allowsUnconfiguredJenkinsFetch(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  return !isPrivateJenkinsHost(parsed.hostname)
}
