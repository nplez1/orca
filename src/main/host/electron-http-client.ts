import { net, session, type Session } from 'electron'
import type { MainHttpClient } from '../network/http-client'
import { hasElectronProxyCredentialsForSession } from '../network/electron-proxy-credentials'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { fetchWithProxyLogin } from './electron-proxy-login-fetch'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

async function hasConfiguredProxyCredentials(
  proxySession: Session,
  signal: AbortSignal | undefined
): Promise<boolean> {
  // Credentials are installed while a proxy policy applies; a cold request must wait for it.
  const readiness = getProxySessionApplicationReadiness(proxySession)
  if (readiness !== true && !(await waitForPromiseWithSignal(Promise.resolve(readiness), signal))) {
    return false
  }
  return hasElectronProxyCredentialsForSession(proxySession)
}

async function fetchFromDefaultSession(url: string, init?: RequestInit): Promise<Response> {
  const proxySession = session.defaultSession
  if (
    isHttpUrl(url) &&
    (await hasConfiguredProxyCredentials(proxySession, init?.signal ?? undefined))
  ) {
    return fetchWithProxyLogin(new Request(url, init), proxySession)
  }
  // Not ready falls through too: the default-session request guard cancels it.
  return net.fetch(url, init)
}

/** Chromium honors session/proxy state; read defaultSession per call because it throws before app readiness. */
export const electronHttpClient: MainHttpClient = {
  fetch: fetchFromDefaultSession,
  // fork-comment-ok: ordering trap. A cold request must not overtake the session's proxy policy, and
  // `hasConfiguredProxyCredentials` is the wait; credentials themselves are the `login` listener's.
  fetchManualRedirects: async (url, init) => {
    const proxySession = session.defaultSession
    await hasConfiguredProxyCredentials(proxySession, init?.signal ?? undefined)
    return fetchWithElectronManualRedirects(url, init, proxySession)
  },
  proxySession: () => session.defaultSession,
  partitionSession: (partition) => session.fromPartition(partition)
}
