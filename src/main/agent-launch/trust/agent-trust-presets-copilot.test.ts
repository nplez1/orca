/**
 * Copilot 1.0.105 heads ~/.copilot/config.json with `//` comments. A strict JSON read skipped the
 * trust write, so the trust menu swallowed every launch prompt (#165).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('appends to a commented config and keeps its comments, keys and items', async () => {
    writeFileSync(configPath, COPILOT_CONFIG)

    await markCopilotFolderTrusted(workspace, home)

    expect(readFileSync(configPath, 'utf-8')).toBe(
      COPILOT_CONFIG.replace('"/already/trusted"\n', `"/already/trusted",\n    "${workspace}"\n`)
    )
  })

  it('adds the key to a commented config that has none', async () => {
    writeFileSync(configPath, '// header\n{\n  "firstLaunchAt": "x"\n}\n')

    await markCopilotFolderTrusted(workspace, home)

    expect(readFileSync(configPath, 'utf-8')).toBe(
      `// header\n{\n  "firstLaunchAt": "x",\n  "trustedFolders": [\n    "${workspace}"\n  ]\n}\n`
    )
  })

  it('leaves a config it cannot parse untouched', async () => {
    const corrupt = '// header\n{ "trustedFolders": [\n'
    writeFileSync(configPath, corrupt)

    await markCopilotFolderTrusted(workspace, home)

    expect(readFileSync(configPath, 'utf-8')).toBe(corrupt)
  })
})
