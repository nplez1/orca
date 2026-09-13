import { createSecureCredentialStore } from '../credentials/secure-credential-store'

export type FireworksCredentials = {
  apiKey: string
  accountIdOverride: string | null
}

const FIREWORKS_LOG_TAG = '[fireworks]'
const FIREWORKS_CREDENTIALS_DESCRIPTION = 'Fireworks credentials'

// Why: the factory stores one opaque string, so both fields travel as a JSON payload in one file.
const fireworksCredentialsStore = createSecureCredentialStore({
  fileName: 'fireworks-credentials.enc',
  envelopePrefix: 'orca-fireworks-credentials:v1:',
  description: FIREWORKS_CREDENTIALS_DESCRIPTION,
  logTag: FIREWORKS_LOG_TAG
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseFireworksCredentials(payload: string): FireworksCredentials {
  const parsed: unknown = JSON.parse(payload)
  if (!isRecord(parsed) || typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim()) {
    throw new Error('malformed Fireworks credentials payload')
  }
  const override =
    typeof parsed.accountIdOverride === 'string' ? parsed.accountIdOverride.trim() : ''
  return {
    apiKey: parsed.apiKey.trim(),
    accountIdOverride: override === '' ? null : override
  }
}

export function hasFireworksCredentials(): boolean {
  return fireworksCredentialsStore.has()
}

export function saveFireworksCredentials(credentials: FireworksCredentials): void {
  const apiKey = credentials.apiKey.trim()
  if (!apiKey) {
    throw new Error('Fireworks API key is required')
  }
  const override = credentials.accountIdOverride?.trim() ?? ''
  const payload: FireworksCredentials = {
    apiKey,
    accountIdOverride: override === '' ? null : override
  }
  fireworksCredentialsStore.save(JSON.stringify(payload))
}

export function readFireworksCredentials(): FireworksCredentials | null {
  const payload = fireworksCredentialsStore.read()
  if (payload === null) {
    return null
  }
  try {
    return parseFireworksCredentials(payload)
  } catch (error) {
    console.error(`${FIREWORKS_LOG_TAG} failed to decode/decrypt credentials`, error)
    throw new Error(`${FIREWORKS_CREDENTIALS_DESCRIPTION} could not be decrypted`)
  }
}

export function clearFireworksCredentials(): void {
  fireworksCredentialsStore.clear()
}
