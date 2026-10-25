import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readKeychainPassword } from '../macos-keychain/generic-password'

const ACTIVE_CLAUDE_SERVICE = 'Claude Code-credentials'

/** A login and the exact item it was read from, so a rotated refresh token can be written back. */
export type ClaudeKeychainCredentialsRead = {
  contents: string
  service: string
  account: string
}

export async function readActiveClaudeKeychainCredentialsStrict(
  configDir?: string
): Promise<ClaudeKeychainCredentialsRead | null> {
  const account = getKeychainUser()
  if (!configDir) {
    const service = claudeKeychainService()
    const contents = await readKeychainPassword(service, account)
    return contents ? { contents, service, account } : null
  }
  // Profile aliases must never fall back to System default credentials.
  for (const dir of claudeConfigDirKeychainAliases(configDir)) {
    const service = claudeKeychainService(dir)
    const contents = await readKeychainPassword(service, account)
    if (contents) {
      return { contents, service, account }
    }
  }
  return null
}

const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLAUDE_CODE_FALLBACK_USER = 'claude-code-user'

function getKeychainUser(): string {
  // Match Claude 2.1+ fallback naming for invalid usernames, including SSO email addresses.
  let user: string
  try {
    user = process.env.USER || process.env.USERNAME || userInfo().username
  } catch {
    return CLAUDE_CODE_FALLBACK_USER
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_CODE_FALLBACK_USER
}

export function claudeKeychainService(configDir?: string): string {
  if (!configDir) {
    return ACTIVE_CLAUDE_SERVICE
  }
  // Match Claude 2.1+ config-scoped Keychain naming.
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `${ACTIVE_CLAUDE_SERVICE}-${suffix}`
}

export function claudeConfigDirKeychainAliases(configDir: string): string[] {
  const aliases = [configDir]
  const missingSegments: string[] = []
  let existingPath = configDir
  while (true) {
    try {
      const canonical = join(realpathSync(existingPath), ...missingSegments)
      if (canonical !== configDir) {
        aliases.push(canonical)
      }
      break
    } catch (error) {
      // Missing paths with parent traversal cannot prove an alias across symlinks.
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT' ||
        configDir.split(/[\\/]/).includes('..')
      ) {
        break
      }
      try {
        // A broken symlink has no known canonical target; do not guess its alias.
        lstatSync(existingPath)
        break
      } catch (missingError) {
        if (
          !(missingError instanceof Error) ||
          !('code' in missingError) ||
          missingError.code !== 'ENOENT'
        ) {
          break
        }
      }
      const parent = dirname(existingPath)
      if (parent === existingPath) {
        break
      }
      // Preserve canonical Keychain lookup without recreating a removed config directory.
      missingSegments.unshift(basename(existingPath))
      existingPath = parent
    }
  }
  return aliases
}

/** Include literal home-variable spellings Claude may have hashed into Keychain names. */
export function claudeConfigDirSpellings(configDir: string, userHome: string): string[] {
  const spellings = new Set<string>()
  for (const dir of claudeConfigDirKeychainAliases(configDir)) {
    const trimmed = dir.replace(/[\\/]+$/, '')
    const rest = trimmed.startsWith(`${userHome}/`) ? trimmed.slice(userHome.length) : null
    for (const spelling of [trimmed, ...(rest ? [`~${rest}`, `$HOME${rest}`] : [])]) {
      spellings.add(spelling)
      spellings.add(`${spelling}/`)
    }
  }
  return [...spellings]
}
