// Sealing for the channel's two keys. A Photon project key can send as the bot and an account service
// key can create projects, so a stored one goes through the host's secret store; a host with no keyring
// falls back to plain base64 and says so, which is the same degradation the bot tool credentials make
// explicit rather than hiding.
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'

/** Whether this host can seal a key it is asked to keep; the setup copy and the status read it. */
export function photonCanSealSecrets(): boolean {
  try {
    return hasSecretStore() && getSecretStore().isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Refuses a key asked to be kept where it could only be written base64. The owner is told why, so
 *  session-only is a choice rather than a surprise. */
export function assertPhotonKeyCanBeStored(storesKey: boolean): void {
  if (storesKey && !photonCanSealSecrets()) {
    throw new Error(
      'This computer cannot seal a key, so Orca will not write one to disk. Connect without keeping it, and paste it again after a restart.'
    )
  }
}

/** A secret as it is written: sealed where this host can, plain base64 where it cannot. */
export function sealPhotonSecret(value: string): string {
  if (photonCanSealSecrets()) {
    return `sealed:${getSecretStore().encryptString(value).toString('base64')}`
  }
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

/** A secret as it is read. Empty when a sealed value cannot be opened here, which the caller reports:
 *  a key that cannot be opened is a key to mint again, not a crash. */
export function unsealPhotonSecret(value: string): string {
  const [kind, payload = ''] = value.split(':', 2)
  const bytes = Buffer.from(payload, 'base64')
  if (kind === 'plain') {
    return bytes.toString('utf8')
  }
  try {
    return getSecretStore().decryptString(bytes)
  } catch {
    return ''
  }
}
