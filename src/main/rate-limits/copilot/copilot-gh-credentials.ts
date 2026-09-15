import { ghExecFileAsync } from '../../git/command-runner/gh-exec-file'
import { isHostCommandMissing } from '../../git/command-runner/github-cli-host-fallback'
import { parseAuthStatus } from '../../github/auth-diagnose'

/**
 * Resolves the enterprise slug for Copilot billing from the user's existing `gh`
 * sign-in, so an enterprise user does not have to mint and paste a token.
 *
 * Why scopes are checked: GitHub's enterprise billing scope can discover the enterprise
 * slug through GraphQL and read its billing data. `read:enterprise` can discover the slug
 * but still needs `manage_billing:enterprise` for billing; `admin:enterprise` implies both.
 */
const SLUG_SCOPES = ['read:enterprise', 'manage_billing:enterprise', 'admin:enterprise']
const BILLING_SCOPES = ['manage_billing:enterprise', 'admin:enterprise']
const ENTERPRISE_SLUG_QUERY = '{ viewer { enterprises(first: 10) { nodes { slug } } } }'

export type CopilotGhCredentialsResult =
  | { status: 'ok'; enterpriseSlug: string }
  /** gh is not on PATH — the paste form is the only route. */
  | { status: 'gh-missing' }
  | { status: 'unauthenticated' }
  /** Signed in, but without the scopes the billing endpoints need. */
  | { status: 'missing-scope'; missing: string[] }
  | { status: 'no-enterprise' }

// Why cached: discovery costs a subprocess per poll cycle and the slug only changes if
// the user's enterprise membership does.
let cachedEnterpriseSlug: string | null = null
// Why a module-level cache rather than service state: `getState()` is synchronous and
// called on every renderer push, so it cannot await a subprocess. The cycle reads this
// snapshot, and the probe is refreshed out of band — never on the fetch critical path,
// where gh latency (or a hung gh) would stall every provider's refresh.
let cachedResult: CopilotGhCredentialsResult | null = null
let cachedAtMs = 0
let refreshInFlight: Promise<CopilotGhCredentialsResult> | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

async function readActiveAccountScopes(): Promise<string[] | null> {
  let text: string
  try {
    // `gh auth status` exits non-zero when nothing is logged in but still prints the
    // diagnostic text, so both streams are read (same reason as auth-diagnose).
    const { stdout, stderr } = await ghExecFileAsync(['auth', 'status'])
    text = `${stdout}\n${stderr}`
  } catch (error) {
    if (isHostCommandMissing(error, 'gh')) {
      return null
    }
    text = ''
  }
  const accounts = parseAuthStatus(text)
  const active = accounts.find((account) => account.active) ?? accounts[0]
  return active ? active.scopes : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readFirstSlug(payload: unknown): string | null {
  const viewer = isRecord(payload) && isRecord(payload.data) ? payload.data.viewer : null
  const enterprises = isRecord(viewer) ? viewer.enterprises : null
  const nodes = isRecord(enterprises) && Array.isArray(enterprises.nodes) ? enterprises.nodes : []
  for (const node of nodes) {
    const slug = isRecord(node) && typeof node.slug === 'string' ? node.slug.trim() : ''
    if (slug) {
      return slug
    }
  }
  return null
}

async function discoverEnterpriseSlug(): Promise<string | null> {
  if (cachedEnterpriseSlug) {
    return cachedEnterpriseSlug
  }
  try {
    const { stdout } = await ghExecFileAsync([
      'api',
      'graphql',
      '-f',
      `query=${ENTERPRISE_SLUG_QUERY}`
    ])
    cachedEnterpriseSlug = readFirstSlug(JSON.parse(stdout))
    return cachedEnterpriseSlug
  } catch {
    return null
  }
}

export async function resolveGhCopilotCredentials(): Promise<CopilotGhCredentialsResult> {
  const scopes = await readActiveAccountScopes()
  // null means gh itself is missing, which the caller reports distinctly from
  // "installed but signed out".
  if (scopes === null) {
    return { status: 'gh-missing' }
  }
  if (scopes.length === 0) {
    return { status: 'unauthenticated' }
  }

  const missing: string[] = []
  if (!SLUG_SCOPES.some((scope) => scopes.includes(scope))) {
    missing.push('read:enterprise')
  }
  if (!BILLING_SCOPES.some((scope) => scopes.includes(scope))) {
    missing.push('manage_billing:enterprise')
  }
  // Why fail closed: the provider item is default-on, so treating a scope-less gh as a
  // source would show a permanent error bar to every enterprise user who never asked
  // for Copilot usage. Falling back to the paste form keeps it quiet instead.
  if (missing.length > 0) {
    return { status: 'missing-scope', missing }
  }

  const enterpriseSlug = await discoverEnterpriseSlug()
  // Why not a scope error: the scopes above were present, so an empty list means the
  // signed-in login simply belongs to no enterprise.
  return enterpriseSlug ? { status: 'ok', enterpriseSlug } : { status: 'no-enterprise' }
}

/** Synchronous view for `getState()` and the fetch cycle. Null until the first probe lands. */
export function getCachedCopilotGhCredentials(): CopilotGhCredentialsResult | null {
  return cachedResult
}

/**
 * Runs the probe and updates the cache. Concurrent callers share one run, so a cycle
 * and a credential change cannot spawn two `gh` processes.
 */
export function refreshCopilotGhCredentials(): Promise<CopilotGhCredentialsResult> {
  if (refreshInFlight) {
    return refreshInFlight
  }
  refreshInFlight = resolveGhCopilotCredentials()
    .then((result) => {
      cachedResult = result
      cachedAtMs = Date.now()
      return result
    })
    .catch((): CopilotGhCredentialsResult => {
      // Why fail quiet: a probe failure must not hide a provider the user configured by
      // hand, and the next cycle retries anyway.
      cachedResult = { status: 'gh-missing' }
      cachedAtMs = Date.now()
      return cachedResult
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

/**
 * The cycle's synchronous read. Warms the cache in the background when it is empty or
 * stale, so a scope change the user made in their terminal is picked up within a cycle
 * or two while a refresh never blocks.
 */
export function readCopilotGhCredentialsForCycle(): CopilotGhCredentialsResult | null {
  if (cachedResult === null || Date.now() - cachedAtMs > CACHE_TTL_MS) {
    void refreshCopilotGhCredentials()
  }
  return cachedResult
}

/** Test seam: discovery is memoised, so suites that change the payload must reset it. */
export function __resetCopilotGhCredentialsCache(): void {
  cachedEnterpriseSlug = null
  cachedResult = null
  cachedAtMs = 0
  refreshInFlight = null
}
