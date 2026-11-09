import { createHash } from 'node:crypto'

/** A fingerprint only has to detect a credential change, so the secret never has to be retained. */
export function usageCredentialFingerprint(secret: string): string {
  return secret ? createHash('sha256').update(secret).digest('hex') : ''
}
