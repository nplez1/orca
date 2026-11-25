/**
 * Copilot 1.0.105 heads ~/.copilot/config.json with `//` comments. A strict JSON read skipped the
 * trust write, so the trust menu swallowed every launch prompt (#165).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { markCopilotFolderTrusted } from './agent-trust-presets'

const COPILOT_CONFIG = `// User settings belong in settings.json.
// This file is managed automatically.
{
  "firstLaunchAt": "2026-10-30T04:29:22.084Z",
  "loggedInUsers": [{ "host": "https://github.com", "login": "octocat" }],
  "trustedFolders": [
    "/already/trusted"
  ]
}
`

describe('markCopilotFolderTrusted', () => {
  let root: string
  let home: string
  let workspace: string
  let configPath: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-copilot-trust-')))
    home = join(root, 'home')
    workspace = join(root, 'worktree')
    mkdirSync(join(home, '.copilot'), { recursive: true })
    mkdirSync(workspace)
    configPath = join(home, '.copilot', 'config.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('trusts the folder in a commented config and keeps its comments and keys', async () => {
    writeFileSync(configPath, COPILOT_CONFIG)

    await markCopilotFolderTrusted(workspace, home)

    const text = readFileSync(configPath, 'utf-8')
    expect(text.startsWith('// User settings belong in settings.json.\n')).toBe(true)
    expect(parseJsonc(text)).toEqual({
      firstLaunchAt: '2026-10-30T04:29:22.084Z',
      loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }],
      trustedFolders: ['/already/trusted', workspace]
    })
  })

  it('leaves a config it cannot parse untouched', async () => {
    const corrupt = '// header\n{ "trustedFolders": [\n'
    writeFileSync(configPath, corrupt)

    await markCopilotFolderTrusted(workspace, home)

    expect(readFileSync(configPath, 'utf-8')).toBe(corrupt)
  })
})
