// Installation tokens last an hour, so Orca mints them on demand and keeps one per installation until it is
// nearly spent. Two callers asking at once share one mint, so a burst of `gh` calls is not a burst of tokens.
import { githubAppTokenNeedsRefresh } from '../../../shared/github/app/github-app-identity'
import { mintInstallationToken, type GithubAppFetch } from './github-app-api'
import type { GithubAppCredentials } from './github-app-credentials'

type CachedToken = { token: string; expiresAtMs: number }

const cache = new Map<number, CachedToken>()
const inFlight = new Map<number, Promise<CachedToken>>()

/**
 * The token for one installation. The credential and the clock are inputs so this stays testable and so a
 * caller that just changed the App's key cannot be served a token minted with the old one.
 */
export async function installationToken(input: {
  credentials: GithubAppCredentials
  installationId: number
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<string> {
  const nowMs = input.nowMs ?? Date.now()
  const cached = cache.get(input.installationId)
  if (cached && !githubAppTokenNeedsRefresh(cached.expiresAtMs, nowMs)) {
    return cached.token
  }

  const pending = inFlight.get(input.installationId)
  if (pending) {
    return (await pending).token
  }

  const minted = mintInstallationToken({
    appId: input.credentials.appId,
    installationId: input.installationId,
    privateKeyPem: input.credentials.privateKeyPem,
    fetch: input.fetch,
    nowMs
  }).then(({ token, expiresAtMs }) => ({ token, expiresAtMs }))

  inFlight.set(input.installationId, minted)
  try {
    const fresh = await minted
    // An expiry GitHub did not state is treated as spent, so the next caller mints rather than trusting it.
    cache.set(input.installationId, {
      token: fresh.token,
      expiresAtMs: Number.isFinite(fresh.expiresAtMs) ? fresh.expiresAtMs : nowMs
    })
    return fresh.token
  } finally {
    inFlight.delete(input.installationId)
  }
}

/** Disconnecting or re-keying the App must not leave a token for the old key behind. */
export function forgetInstallationTokens(installationId?: number): void {
  if (installationId === undefined) {
    cache.clear()
    return
  }
  cache.delete(installationId)
}
