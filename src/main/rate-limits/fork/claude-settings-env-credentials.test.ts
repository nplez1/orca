import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseClaudeSettingsEnvToken,
  readClaudeOAuthCredentials
} from '../claude-oauth-credentials'

const keychain = vi.hoisted(() => vi.fn())
vi.mock('../../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: keychain
}))

const roots: string[] = []

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-settings-env-'))
  roots.push(dir)
  return dir
}

function writeSettings(dir: string, name: string, env: Record<string, string>): void {
  writeFileSync(join(dir, name), JSON.stringify({ env }))
}

beforeEach(() => {
  keychain.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('parseClaudeSettingsEnvToken', () => {
  it('reads the OAuth token Claude Code keeps in its settings env', () => {
    expect(
      parseClaudeSettingsEnvToken(
        JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc' } })
      )
    ).toBe('sk-ant-oat01-abc')
  })

  it('takes an auth token only when it is an OAuth token, never a bare API key', () => {
    expect(
      parseClaudeSettingsEnvToken(
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-x' } })
      )
    ).toBe('sk-ant-oat01-x')
    expect(
      parseClaudeSettingsEnvToken(
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-x' } })
      )
    ).toBeNull()
  })

  it('reports nothing for settings with no env or no JSON', () => {
    expect(parseClaudeSettingsEnvToken(JSON.stringify({ theme: 'dark' }))).toBeNull()
    expect(parseClaudeSettingsEnvToken('not json')).toBeNull()
  })
})

describe('readClaudeOAuthCredentials with a settings-env login', () => {
  it('finds the login when the keychain holds nothing and there is no credentials file', async () => {
    const dir = configDir()
    writeSettings(dir, 'settings.json', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc' })

    const reading = await readClaudeOAuthCredentials({ credentialsFileConfigDir: dir })

    expect(reading.token).toBe('sk-ant-oat01-abc')
    expect(reading.source).toBe('settings-env')
    // No refresh token: Orca must never rewrite the CLI's own settings to renew a login.
    expect(reading.hasRefreshableCredentials).toBe(false)
    expect(reading.refreshTarget).toBeUndefined()
  })

  it('lets settings.local.json override settings.json, the way the CLI applies them', async () => {
    const dir = configDir()
    writeSettings(dir, 'settings.json', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-base' })
    writeSettings(dir, 'settings.local.json', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-local' })

    expect((await readClaudeOAuthCredentials({ credentialsFileConfigDir: dir })).token).toBe(
      'sk-ant-oat01-local'
    )
  })

  it('still prefers a credentials-file login over the settings env', async () => {
    const dir = configDir()
    writeSettings(dir, 'settings.json', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-settings' })
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file', refreshToken: 'r' } })
    )

    const reading = await readClaudeOAuthCredentials({ credentialsFileConfigDir: dir })

    expect(reading.token).toBe('sk-ant-oat01-file')
    expect(reading.source).toBe('credentials-file')
  })

  it('reports an absent login when no source carries one', async () => {
    const reading = await readClaudeOAuthCredentials({ credentialsFileConfigDir: configDir() })

    expect(reading.token).toBeNull()
    expect(reading.source).toBe('none')
  })
})
