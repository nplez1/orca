import { HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'
import { getSecretStore } from '../../shared/secret-store'
import { readCredentialFileProtection } from '../credential-file-protection'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import {
  classifyUnenvelopedCredential,
  type SecretAtRestProtection
} from '../../shared/secret-at-rest-protection'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), HOME_DIRECTORY_NAME)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return
  }
  // Why also on an existing directory: this home holds every credential store, and one created by an
  // older build stays group- and world-readable until something tightens it. Read first so a save does
  // not chmod a directory that is already restricted.
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) {
      chmodSync(dir, 0o700)
    }
  } catch {
    // Best-effort: an unwritable mode does not make the key below unreadable.
  }
}

export function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

function readLegacyJsonStoredOpenAiKey(): StoredOpenAiKey | null {
  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredOpenAiKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasOpenAiSpeechApiKey(): boolean {
  // Existence checks avoid macOS keychain prompts during startup/settings refresh.
  return existsSync(getOpenAiKeyPath())
}

/** Check host decryption: orcad may not open a desktop safeStorage key even when its file exists. */
export function canReadOpenAiSpeechApiKey(): boolean {
  if (!hasOpenAiSpeechApiKey()) {
    return false
  }
  try {
    readOpenAiSpeechApiKey()
    return true
  } catch {
    return false
  }
}

/** Stored protection, or null when no key exists. */
export function getOpenAiSpeechApiKeyProtection(): SecretAtRestProtection | null {
  // The legacy JSON wrapper only ever held base64 ciphertext, so it is sealed by shape.
  if (readLegacyJsonStoredOpenAiKey()) {
    return 'sealed'
  }
  return readCredentialFileProtection(getOpenAiKeyPath())
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  ensureOrcaDir()
  // Why the atomic credential writer rather than `writeFileSync`: `mode` applies only at creation, so a
  // rewrite kept whatever mode the file already had, and the in-place truncate lost the key to a crash
  // mid-write. This stages, fsyncs and renames, and restricts the new inode on both platforms.
  if (getSecretStore().isEncryptionAvailable()) {
    writeCredentialFileAtomic(getOpenAiKeyPath(), getSecretStore().encryptString(trimmed))
    cachedOpenAiSpeechApiKey = trimmed
    return
  }

  console.warn('[speech] secret encryption unavailable — storing OpenAI speech key in plaintext')
  writeCredentialFileAtomic(getOpenAiKeyPath(), Buffer.from(trimmed, 'utf8'))
  cachedOpenAiSpeechApiKey = trimmed
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('OpenAI API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    const legacyJson = readLegacyJsonStoredOpenAiKey()
    if (legacyJson) {
      cachedOpenAiSpeechApiKey = getSecretStore().decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedOpenAiSpeechApiKey
    }
    cachedOpenAiSpeechApiKey = getSecretStore().isEncryptionAvailable()
      ? decryptOrLegacyPlaintext(raw)
      : plaintextOnly(raw)
    return cachedOpenAiSpeechApiKey
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
}

// Without sealing, another store's ciphertext cannot be a usable key.
function plaintextOnly(raw: Buffer): string {
  if (classifyUnenvelopedCredential(raw) !== 'plaintext') {
    throw new Error('sealed by another secret store')
  }
  return raw.toString('utf8')
}

// Keys saved before sealing remain plaintext until migration or re-save.
function decryptOrLegacyPlaintext(raw: Buffer): string {
  try {
    return getSecretStore().decryptString(raw)
  } catch (error) {
    if (classifyUnenvelopedCredential(raw) === 'plaintext') {
      return raw.toString('utf8')
    }
    throw error
  }
}

export function clearOpenAiSpeechApiKey(): void {
  cachedOpenAiSpeechApiKey = null
  rmSync(getOpenAiKeyPath(), { force: true })
}
