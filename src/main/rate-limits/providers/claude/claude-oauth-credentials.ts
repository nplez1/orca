import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import type { ClaudeOAuthCredentialTarget } from '../../../claude-accounts/claude-oauth-credential-store'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { readActiveClaudeKeychainCredentialsStrict } from '../../../claude-accounts/runtime-auth/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import { readUserClaudeConfigDir } from '../../../claude-accounts/profiles/claude-profile-paths'
import { getClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  // fork-comment-ok: fork-only source; a login kept in the CLI's own settings env.
  | 'settings-env'
  | 'none'
export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  /** Epoch ms; Claude Code 2.1.x records it beside the refresh token. */
  refreshTokenExpiresAt?: number
  /** Last plan Claude Code wrote beside this token, e.g. "pro" or "max_20x"; not live billing. */
  planType?: string
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
const schema = lazyZodSchema(() =>
  z.object({
    claudeAiOauth: z
      .object({
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        refreshTokenExpiresAt: z.unknown().optional(),
        // Plan metadata never decides whether the token is usable.
        subscriptionType: z.unknown().optional(),
        rateLimitTier: z.unknown().optional()
      })
      .optional()
  })
)

// fork-comment-ok: fork-only source; see LOCAL-PATCHES.md `local(usage)`.
const settingsEnvSchema = z.object({
  env: z
    .object({
      CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
      ANTHROPIC_AUTH_TOKEN: z.string().optional()
    })
    .optional()
})
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat'

function settingsEnvToken(raw: string | undefined): string | null {
  const candidate = raw?.trim()
  return candidate ? candidate : null
}

export function parseClaudeSettingsEnvToken(raw: string): string | null {
  try {
    const env = settingsEnvSchema.parse(JSON.parse(raw)).env
    const oauthToken = settingsEnvToken(env?.CLAUDE_CODE_OAUTH_TOKEN)
    if (oauthToken) {
      return oauthToken
    }
    const authToken = settingsEnvToken(env?.ANTHROPIC_AUTH_TOKEN)
    return authToken?.startsWith(OAUTH_TOKEN_PREFIX) ? authToken : null
  } catch {
    return null
  }
}

async function readClaudeSettingsEnvCredentials(
  configDir: string
): Promise<ClaudeOAuthCredentialReadResult | null> {
  // fork-comment-ok: settings.local.json wins over settings.json, as the CLI applies them.
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const token = parseClaudeSettingsEnvToken(await readFile(path.join(configDir, name), 'utf8'))
      if (token) {
        return { token, hasRefreshableCredentials: false, source: 'settings-env' }
      }
    } catch {
      // An unreadable or absent settings file is simply not this source.
    }
  }
  return null
}
export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource,
  target?: ClaudeOAuthCredentialTarget
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = schema.parse(JSON.parse(raw)).claudeAiOauth
    const planType = readClaudePlanType(oauth?.subscriptionType, oauth?.rateLimitTier)
    // The usage server, not stored expiresAt, decides token validity.
    return {
      token: oauth?.accessToken || null,
      hasRefreshableCredentials: Boolean(oauth?.refreshToken),
      ...(typeof oauth?.refreshTokenExpiresAt === 'number'
        ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
        : {}),
      ...(planType ? { planType } : {}),
      source,
      ...(target ? { refreshTarget: target } : {})
    }
  } catch {
    return { ...emptyClaudeOAuthCredentialReadResult(), unavailable: true }
  }
}
// The tier only refines Max ("default_claude_max_20x" → "max_20x"); it never names a plan alone.
function readClaudePlanType(subscription: unknown, tier: unknown): string | undefined {
  const plan = typeof subscription === 'string' ? subscription.trim() : ''
  if (!plan) {
    return undefined
  }
  const multiplier = typeof tier === 'string' ? /(?:^|_)max_(\d+x)$/i.exec(tier.trim())?.[1] : null
  // Other values keep the spelling Claude Code wrote.
  return plan.toLowerCase() === 'max' && multiplier ? `max_${multiplier.toLowerCase()}` : plan
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
  const configDir = options?.credentialsFileConfigDir ?? path.join(homedir(), '.claude')
  const credentialsPath = path.join(configDir, '.credentials.json')
  let file: ClaudeOAuthCredentialReadResult | null = null
  let fileMissing = false
  let fileUnreadable = false
  try {
    file = parseClaudeOAuthCredentialsJson(
      await readFile(credentialsPath, 'utf8'),
      'credentials-file',
      {
        kind: 'file',
        path: credentialsPath
      }
    )
    // A file with no token must not hide a refreshable or unreadable Keychain login.
    return file.token || !(keychain.hasRefreshableCredentials || keychain.unavailable)
      ? file
      : keychain
  } catch (error) {
    fileMissing = isDefinitiveAbsence(error)
    fileUnreadable = !fileMissing
  }
  if (file?.token) {
    return file
  }
  // fork-comment-ok: fork-only source ordering; the settings env is the CLI's own login, read last.
  const settingsEnv = await readClaudeSettingsEnvCredentials(configDir)
  if (settingsEnv) {
    return settingsEnv
  }
  if (fileUnreadable) {
    return { ...keychain, unavailable: true }
  }
  return fileMissing ? keychain : (file ?? keychain)
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
