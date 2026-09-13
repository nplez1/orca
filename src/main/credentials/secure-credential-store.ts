import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

export type SecureCredentialStoreOptions = {
  fileName: string
  /** Per-store envelope prefix so two stores can never read each other's file. */
  envelopePrefix: string
  /** Human label feeding error/warn wording, e.g. `DeepSeek API key`. */
  description: string
  /** Bracket-wrapped log scope, e.g. `[deepseek]`. */
  logTag: string
}

export type SecureCredentialStore = {
  has: () => boolean
  save: (value: string) => void
  read: () => string | null
  protection: () => SecretAtRestProtection | null
  clear: () => void
}

type CredentialEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

export function createSecureCredentialStore(
  options: SecureCredentialStoreOptions
): SecureCredentialStore {
  const { fileName, envelopePrefix, description, logTag } = options
  let cachedValue: string | null = null
  let warnedHardenFailure = false

  const resolvePath = (): string => join(join(homedir(), '.orca'), fileName)

  const encodeEnvelope = (kind: CredentialEnvelope['kind'], payload: Buffer): string =>
    `${envelopePrefix}${kind}:${payload.toString('base64')}`

  function decodeEnvelope(raw: Buffer): CredentialEnvelope {
    const text = raw.toString('utf8')
    if (!text.startsWith(envelopePrefix)) {
      throw new Error(`${description} could not be decrypted`)
    }
    const rest = text.slice(envelopePrefix.length)
    const separator = rest.indexOf(':')
    if (separator === -1) {
      throw new Error(`${description} could not be decrypted`)
    }
    const kind = rest.slice(0, separator)
    if (kind !== 'encrypted' && kind !== 'plaintext') {
      throw new Error(`${description} could not be decrypted`)
    }
    return {
      kind,
      payload: Buffer.from(rest.slice(separator + 1), 'base64')
    }
  }

  function decryptEnvelope(envelope: CredentialEnvelope): string {
    if (envelope.kind === 'plaintext') {
      return envelope.payload.toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`${description} could not be decrypted`)
    }
    return safeStorage.decryptString(envelope.payload)
  }

  return {
    has(): boolean {
      const path = resolvePath()
      if (!existsSync(path)) {
        return false
      }
      try {
        hardenExistingSecureFile(path)
      } catch (error) {
        if (!warnedHardenFailure) {
          warnedHardenFailure = true
          console.warn(
            `${logTag} Failed to harden ${description} file while checking status`,
            error
          )
        }
      }
      return true
    },

    save(value: string): void {
      const trimmed = value.trim()
      if (!trimmed) {
        throw new Error(`${description} is required`)
      }
      const path = resolvePath()
      if (safeStorage.isEncryptionAvailable()) {
        writeSecureFile(path, encodeEnvelope('encrypted', safeStorage.encryptString(trimmed)))
        cachedValue = trimmed
        return
      }
      console.warn(
        `${logTag} safeStorage encryption unavailable — storing ${description} in plaintext`
      )
      writeSecureFile(path, encodeEnvelope('plaintext', Buffer.from(trimmed, 'utf8')))
      cachedValue = trimmed
    },

    read(): string | null {
      if (cachedValue !== null) {
        return cachedValue
      }
      const path = resolvePath()
      if (!existsSync(path)) {
        return null
      }
      // Why: keep hardening out of the decode/decrypt try below so a chmod/ACL
      // failure isn't misreported as a decrypt failure (matches has).
      try {
        hardenExistingSecureFile(path)
      } catch (error) {
        console.warn(`${logTag} Failed to harden ${description} file while reading`, error)
      }
      try {
        const envelope = decodeEnvelope(readFileSync(path))
        cachedValue = decryptEnvelope(envelope)
        return cachedValue
      } catch (error) {
        console.error(`${logTag} failed to decode/decrypt API key`, error)
        throw new Error(`${description} could not be decrypted`)
      }
    },

    /**
     * How the stored value is protected, or null when none is stored.
     *
     * Reads the envelope kind only — no decrypt, so this cannot trigger a keychain prompt
     * and is safe to call from a status handler.
     */
    protection(): SecretAtRestProtection | null {
      const path = resolvePath()
      if (!existsSync(path)) {
        return null
      }
      try {
        return decodeEnvelope(readFileSync(path)).kind === 'plaintext' ? 'plaintext' : 'sealed'
      } catch {
        // An undecodable envelope is a decrypt-time error to report, not a protection claim.
        return null
      }
    },

    clear(): void {
      cachedValue = null
      rmSync(resolvePath(), { force: true })
    }
  }
}
