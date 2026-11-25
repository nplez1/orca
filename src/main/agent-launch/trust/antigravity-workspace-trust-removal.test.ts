/**
 * A commented Antigravity settings.json is trusted as JSONC, so its removal must read it as JSONC
 * too, or the entry outlives the worktree and the cleanup retries forever (#165).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'
import { markAntigravityWorkspaceTrusted } from './agent-trust-presets'
import { removeOrcaCreatedAntigravityTrust } from './antigravity-workspace-trust-removal'

const ledger: { path: string } = vi.hoisted(() => ({ path: '' }))

vi.mock('./antigravity-workspace-trust-ownership', () => ({
  recordOrcaCreatedAntigravityTrust: (settingsPath: string, workspacePath: string, entry: string) =>
    createAgentTrustOwnershipLedger(
      () => ledger.path,
      (projectPath) => resolve(projectPath)
    ).record(settingsPath, workspacePath, entry)
}))

const SETTINGS = `// agy settings
{
  "model": "x", // pinned
  "trustedWorkspaces": [
    "/users/own"
  ]
}
`

describe('removeOrcaCreatedAntigravityTrust', () => {
  let root: string
  let home: string
  let workspace: string
  let settingsPath: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agy-trust-')))
    home = join(root, 'home')
    workspace = join(root, 'worktree')
    ledger.path = join(root, 'ledger.json')
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(workspace)
    settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('removes the entry Orca added to a commented config and keeps the rest', async () => {
    writeFileSync(settingsPath, SETTINGS)
    await markAntigravityWorkspaceTrusted(workspace, home)
    expect(readFileSync(settingsPath, 'utf-8')).toContain(`"${workspace}"`)

    removeOrcaCreatedAntigravityTrust(ledger.path, workspace)

    expect(readFileSync(settingsPath, 'utf-8')).toBe(SETTINGS)
    expect(
      createAgentTrustOwnershipLedger(
        () => ledger.path,
        (projectPath) => resolve(projectPath)
      ).listConfigFiles(workspace)
    ).toEqual([])
  })

  it.each([
    [
      'the last item of an inline array',
      '{"trustedWorkspaces": ["/a", "WS"]}',
      '{"trustedWorkspaces": ["/a"]}'
    ],
    [
      'the first item of an inline array',
      '{"trustedWorkspaces":["WS","/a"]}',
      '{"trustedWorkspaces":["/a"]}'
    ],
    [
      'the only item of a minified file',
      '{"m":1,"trustedWorkspaces":["WS"]}',
      '{"m":1,"trustedWorkspaces":[]}'
    ],
    [
      'the item after a commented neighbour',
      '{\n  "trustedWorkspaces": [\n    "/a", // mine\n    "WS"\n  ]\n}\n',
      '{\n  "trustedWorkspaces": [\n    "/a" // mine\n  ]\n}\n'
    ],
    [
      'the array a duplicate key resolves to',
      '{"trustedWorkspaces":["WS"],"trustedWorkspaces":["/a","WS"]}',
      '{"trustedWorkspaces":["WS"],"trustedWorkspaces":["/a"]}'
    ]
  ])('removes %s', (_name, before, after) => {
    writeFileSync(settingsPath, before.replaceAll('WS', workspace))
    createAgentTrustOwnershipLedger(
      () => ledger.path,
      (projectPath) => resolve(projectPath)
    ).record(settingsPath, workspace, workspace)

    removeOrcaCreatedAntigravityTrust(ledger.path, workspace)

    expect(readFileSync(settingsPath, 'utf-8')).toBe(after.replaceAll('WS', workspace))
  })
})
