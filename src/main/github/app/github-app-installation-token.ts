// Installation tokens last an hour, so Orca mints them on demand and keeps one per installation until it is
// nearly spent. Two callers asking at once share one mint, so a burst of `gh` calls is not a burst of tokens.
import { githubAppTokenNeedsRefresh } from '../../../shared/github/app/github-app-identity'
import { mintInstallationToken, type GithubAppFetch } from './github-app-api'
import type { GithubAppCredentials } from './github-app-credentials'

type CachedToken = { token: string; expiresAtMs: number }

const cache = new Map<number, CachedToken>()
const inFlight = new Map<number, Promise<CachedToken>>()
/** Bumped by `forgetInstallationTokens`, so a mint in flight during a disconnect is not cached afterwards. */
let generation = 0

export async function installationToken(input: {
  credentials: GithubAppCredentials
  installationId: number
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<CachedToken> {
  const nowMs = input.nowMs ?? Date.now()
  const cached = cache.get(input.installationId)
  if (cached && !githubAppTokenNeedsRefresh(cached.expiresAtMs, nowMs)) {
    return cached
  }

  const pending = inFlight.get(input.installationId)
  if (pending) {
    return await pending
  }

  const minted = mintInstallationToken({
    appId: input.credentials.appId,
    installationId: input.installationId,
    privateKeyPem: input.credentials.privateKeyPem,
    fetch: input.fetch,
    nowMs
  }).then(({ token, expiresAtMs }) => ({
    token,
    // Normalised here, not only for the minting caller: a joiner gets this too, and NaN would read as fresh.
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs
  }))

  const startedAt = generation
  inFlight.set(input.installationId, minted)
  try {
    const fresh = await minted
    if (generation === startedAt) {
      cache.set(input.installationId, fresh)
    }
    return fresh
  } finally {
    inFlight.delete(input.installationId)
  }
}

/** Disconnecting or re-keying the App must not leave a token for the old key behind. */
export function forgetInstallationTokens(installationId?: number): void {
  generation += 1
  if (installationId === undefined) {
    cache.clear()
    return
  }
  cache.delete(installationId)
}

/** When a token already minted for this installation expires; null when none is held. Never mints one. */
export function cachedInstallationTokenExpiry(installationId: number): number | null {
  return cache.get(installationId)?.expiresAtMs ?? null
}

/** The token itself, so a disconnect can hand it back to GitHub; null when none is held. */
export function cachedInstallationToken(installationId: number): string | null {
  return cache.get(installationId)?.token ?? null
}

/** Every installation this host is holding a token for, so a disconnect can revoke each one. */
export function cachedInstallationIds(): number[] {
  return [...cache.keys()]
}
