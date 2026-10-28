import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import type { ClaudeOAuthCredentialTarget } from '../claude-accounts/claude-oauth-credential-store'
import { readUserClaudeConfigDir } from '../claude-accounts/claude-profile-paths'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  | 'none'
export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  /** Epoch ms; Claude Code 2.1.x records it beside the refresh token. */
  refreshTokenExpiresAt?: number
  source: ClaudeOAuthCredentialSource
  /** Where this login lives: the only credential a refresh may write back to. */
  refreshTarget?: ClaudeOAuthCredentialTarget
  keychainUnavailable?: boolean
  unavailable?: boolean
}
type ClaudeOAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
  /** System Default only: a managed profile never reads another login's item. */
  unsuffixedKeychainFallback?: boolean
}
const schema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      refreshTokenExpiresAt: z.unknown().optional()
    })
    .optional()
})
export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource,
  target?: ClaudeOAuthCredentialTarget
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = schema.parse(JSON.parse(raw)).claudeAiOauth
    // The usage server, not stored expiresAt, decides token validity.
    return {
      token: oauth?.accessToken || null,
      hasRefreshableCredentials: Boolean(oauth?.refreshToken),
      ...(typeof oauth?.refreshTokenExpiresAt === 'number'
        ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
        : {}),
      source,
      ...(target ? { refreshTarget: target } : {})
    }
  } catch {
    return { ...emptyClaudeOAuthCredentialReadResult(), unavailable: true }
  }
}
export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}
export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const item = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return item
      ? parseClaudeOAuthCredentialsJson(item.contents, source, {
          kind: 'keychain',
          service: item.service,
          account: item.account
        })
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return {
      ...emptyClaudeOAuthCredentialReadResult(),
      unavailable: true,
      keychainUnavailable: true
    }
  }
}
async function readClaudeKeychainCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  if (!options?.keychainConfigDir) {
    return readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
  }
  const scoped = await readClaudeCredentialsFromStrictKeychain(
    options.keychainConfigDir,
    'scoped-keychain'
  )
  if (scoped.token || !options.unsuffixedKeychainFallback) {
    return scoped
  }
  const legacy = await readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
  // A readable token takes precedence over an unavailable keychain item.
  const candidates = [scoped, legacy]
  return (
    candidates.find((candidate) => candidate.token) ??
    candidates.find((candidate) => candidate.unavailable) ??
    legacy
  )
}
export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  const keychain =
    process.platform === 'darwin'
      ? await readClaudeKeychainCredentials(options)
      : emptyClaudeOAuthCredentialReadResult()
  if (keychain.token) {
    return keychain
  }
  const credentialsPath = path.join(
    options?.credentialsFileConfigDir ?? path.join(homedir(), '.claude'),
    '.credentials.json'
  )
  try {
    return parseClaudeOAuthCredentialsJson(
      await readFile(credentialsPath, 'utf8'),
      'credentials-file',
      { kind: 'file', path: credentialsPath }
    )
  } catch (error) {
    return isDefinitiveAbsence(error) ? keychain : { ...keychain, unavailable: true }
  }
}
export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  const accountDir = authPreparation.envPatch.CLAUDE_CONFIG_DIR
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    // Claude keys System Default items by the user config folder resolved from the login environment.
    keychainConfigDir:
      accountDir ??
      getClaudeProfileRouter()?.userConfigDir() ??
      readUserClaudeConfigDir(process.env),
    // An unsuffixed lookup is exclusively System default, never a fallback from an account.
    unsuffixedKeychainFallback: !accountDir
  }
}
