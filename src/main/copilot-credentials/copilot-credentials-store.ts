import { createSecureCredentialStore } from '../credentials/secure-credential-store'

/**
 * Copilot usage comes from GitHub's billing API, which needs a token holding the
 * "Enterprise billing" read permission plus the enterprise slug to query. Both are
 * stored together because neither is useful without the other.
 */
export type CopilotCredentials = {
  token: string
  enterpriseSlug: string
}

const copilotCredentialsStore = createSecureCredentialStore({
  fileName: 'copilot-credentials.enc',
  envelopePrefix: 'orca-copilot-credentials:v1:',
  description: 'GitHub Copilot credentials',
  logTag: '[copilot]'
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCopilotCredentials(payload: string): CopilotCredentials {
  const parsed: unknown = JSON.parse(payload)
  if (
    !isRecord(parsed) ||
    typeof parsed.token !== 'string' ||
    !parsed.token.trim() ||
    typeof parsed.enterpriseSlug !== 'string' ||
    !parsed.enterpriseSlug.trim()
  ) {
    throw new Error('GitHub Copilot credentials are incomplete')
  }
  return { token: parsed.token.trim(), enterpriseSlug: parsed.enterpriseSlug.trim() }
}

export function hasCopilotCredentials(): boolean {
  return copilotCredentialsStore.has()
}

export function saveCopilotCredentials(credentials: CopilotCredentials): void {
  const token = credentials.token.trim()
  const enterpriseSlug = credentials.enterpriseSlug.trim()
  if (!token) {
    throw new Error('GitHub token is required')
  }
  if (!enterpriseSlug) {
    throw new Error('GitHub enterprise slug is required')
  }
  copilotCredentialsStore.save(JSON.stringify({ token, enterpriseSlug }))
}

/**
 * Null only when nothing is stored. A stored-but-unreadable payload throws, so the
 * service reports a Copilot credential error instead of silently polling with none.
 */
export function readCopilotCredentials(): CopilotCredentials | null {
  const payload = copilotCredentialsStore.read()
  return payload === null ? null : parseCopilotCredentials(payload)
}

export function clearCopilotCredentials(): void {
  copilotCredentialsStore.clear()
}
