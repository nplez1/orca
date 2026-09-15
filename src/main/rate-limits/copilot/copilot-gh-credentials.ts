import { ghExecFileAsync } from '../../git/command-runner/gh-exec-file'
import { isHostCommandMissing } from '../../git/command-runner/github-cli-host-fallback'
import { parseAuthStatus } from '../../github/auth-diagnose'

/**
 * Verifies that the GitHub CLI sign-in can read the user's Copilot entitlement.
 *
 * Why scopes are checked: GitHub's per-user Copilot entitlement endpoint requires
 * the ordinary `user` scope, not enterprise billing or administration.
 */
const COPILOT_USER_SCOPE = 'user'

export type CopilotGhCredentialsResult =
  | { status: 'ok' }
  /** gh is not on PATH — the stored-token override is the only route. */
  | { status: 'gh-missing' }
  | { status: 'unauthenticated' }
  /** Signed in, but without the scope the entitlement endpoint needs. */
  | { status: 'missing-scope'; missing: string[] }

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
  if (!scopes.includes(COPILOT_USER_SCOPE)) {
    missing.push(COPILOT_USER_SCOPE)
  }
  // Why fail closed: the provider item is default-on, so treating a scope-less gh as a
  // source would show a permanent error bar to every user who never asked for Copilot
  // usage. Falling back to the stored-token override keeps it quiet instead.
  if (missing.length > 0) {
    return { status: 'missing-scope', missing }
  }
  return { status: 'ok' }
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
  cachedResult = null
  cachedAtMs = 0
  refreshInFlight = null
}
