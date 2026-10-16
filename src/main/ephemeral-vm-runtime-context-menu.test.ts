import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { OrcaVmRecipe, OrcaVmRecipeContextMenuItem } from '../shared/orca-yaml-hook-types'
import type { Store } from './persistence'

const mocks = vi.hoisted(() => ({
  getRuntimeRecipeContext: vi.fn(),
  listEnvironments: vi.fn()
}))

vi.mock('./ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: mocks.getRuntimeRecipeContext
}))
vi.mock('../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.listEnvironments
}))

import {
  resolveEphemeralVmRuntimeHostName,
  runEphemeralVmRuntimeContextMenuItem
} from './ephemeral-vm-runtime-context-menu'

const RUNTIME_ID = 'runtime-1'

const WORKSPACE_PATH = '/workspace/repo/.orca-worktrees/fix-login'

const SSH_CONNECTION = {
  type: 'ssh',
  projectRoot: '/workspace/repo',
  target: { label: 'node-9f2c', host: 'host', port: 22, username: 'orca' }
} as const

const ITEMS: OrcaVmRecipeContextMenuItem[] = [
  { id: 'launch-vnc', label: 'Launch VNC', command: 'unused' },
  { id: 'launch-rdp', label: 'Launch RDP', command: 'unused' }
]

/** The mocked resolver never reads the store, so only a Store-shaped value has to exist. */
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getRuntimeRecipeContext is mocked in this file, so no Store member is ever called.
const unusedStore = {} as Store

type Fixture = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
}

const tempDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

/**
 * A real item script rather than a stub: the property under test is which values a recipe author
 * actually receives, and only a process that prints what it saw can show that.
 */
function writeItemScript(repoPath: string, name: string): { command: string; seenPath: string } {
  const scriptPath = join(repoPath, `${name}.js`)
  const seenPath = join(repoPath, `${name}.seen`)
  writeFileSync(
    scriptPath,
    [
      "const fs = require('node:fs')",
      "let input = ''",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      '  fs.writeFileSync(',
      `    ${JSON.stringify(seenPath)},`,
      '    JSON.stringify({',
      '      mode: process.env.ORCA_VM_MODE,',
      '      hostName: process.env.ORCA_HOST_NAME,',
      '      workspaceName: process.env.ORCA_WORKSPACE_NAME,',
      '      workspacePath: process.env.ORCA_WORKSPACE_PATH,',
      '      itemId: process.env.ORCA_CONTEXT_MENU_ITEM_ID,',
      '      payload: JSON.parse(input)',
      '    })',
      '  )',
      '})'
    ].join('\n')
  )
  return { command: nodeCommand(scriptPath), seenPath }
}

function baseRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: RUNTIME_ID,
    recipeId: 'team-machine',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix Login Race',
    connectionMode: 'ssh',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: { schemaVersion: 1, connection: SSH_CONNECTION },
    ...overrides
  }
}

function makeFixture(recipe: Partial<OrcaVmRecipe> = {}): Fixture {
  const fixture: Fixture = {
    userDataPath: makeDir('orca-vm-menu-user-data-'),
    repoPath: makeDir('orca-vm-menu-repo-'),
    recipe: {
      id: 'team-machine',
      name: 'Team machine',
      create: './create.sh',
      contextMenuItems: ITEMS,
      ...recipe
    }
  }
  mocks.getRuntimeRecipeContext.mockImplementation(
    (_store: unknown, userDataPath: string, runtimeId: string) => {
      const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
      }
      return {
        runtime,
        repo: { ok: true, repo: { path: fixture.repoPath, id: 'repo-1' } },
        recipe: fixture.recipe
      }
    }
  )
  return fixture
}

function seedRuntime(
  fixture: Fixture,
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return upsertEphemeralVmRuntime(fixture.userDataPath, baseRuntime(overrides))
}

function run(fixture: Fixture, itemId = 'launch-vnc', workspacePath = WORKSPACE_PATH) {
  return runEphemeralVmRuntimeContextMenuItem({
    userDataPath: fixture.userDataPath,
    store: unusedStore,
    runtimeId: RUNTIME_ID,
    itemId,
    workspacePath
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listEnvironments.mockReturnValue([])
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runEphemeralVmRuntimeContextMenuItem', () => {
  it('runs the clicked item with the host name, workspace name and workspace path', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    const result = await run(fixture)

    expect(result).toMatchObject({
      runtimeId: RUNTIME_ID,
      itemId: 'launch-vnc',
      itemLabel: 'Launch VNC',
      hostName: 'node-9f2c',
      workspacePath: WORKSPACE_PATH
    })
    expect(JSON.parse(readFileSync(seenPath, 'utf8'))).toEqual({
      mode: 'context-menu',
      hostName: 'node-9f2c',
      workspaceName: 'Fix Login Race',
      workspacePath: WORKSPACE_PATH,
      itemId: 'launch-vnc',
      payload: {
        schemaVersion: 1,
        mode: 'context-menu',
        recipeId: 'team-machine',
        instanceId: RUNTIME_ID,
        workspaceId: 'workspace-1',
        workspaceName: 'Fix Login Race',
        recipeResult: { schemaVersion: 1, connection: SSH_CONNECTION },
        hostName: 'node-9f2c',
        workspacePath: WORKSPACE_PATH,
        itemId: 'launch-vnc',
        itemLabel: 'Launch VNC'
      }
    })
  })

  it('runs the command the host snapshotted, not the one the recipe declares now', async () => {
    const fixture = makeFixture()
    seedRuntime(fixture, { contextMenuItems: [{ ...ITEMS[0]!, command: 'exit 9' }] })
    // Why: a click is authorized against the recipe the host was created with, so a later
    // orca.yaml edit must not redirect an existing workspace's menu at another script.
    const edited = writeItemScript(fixture.repoPath, 'edited')
    fixture.recipe.contextMenuItems = [
      { id: 'launch-vnc', label: 'Launch VNC', command: edited.command }
    ]

    // The snapshot's command is the one that ran — and it is the one that failed.
    await expect(run(fixture)).rejects.toThrow('exited with code 9')
    expect(existsSync(edited.seenPath)).toBe(false)
  })

  it('refuses an item the host never snapshotted, even when the recipe declares it now', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    // Why the recipe snapshot too: the strict snapshot drops `contextMenuItems`, so a host created by
    // current code can only have the field on the record — and the menu offers only what is there.
    seedRuntime(fixture, {
      recipe: {
        id: 'team-machine',
        name: 'Team machine',
        create: './create.sh'
      }
    })

    await expect(run(fixture)).rejects.toThrow(
      'Recipe "team-machine" does not declare the context menu item "launch-vnc".'
    )
    expect(existsSync(seenPath)).toBe(false)
  })

  it('refuses a released host without running anything', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, {
      contextMenuItems: fixture.recipe.contextMenuItems,
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    await expect(run(fixture)).rejects.toThrow(
      'This host is released or being removed, so its context menu actions are gone.'
    )
    expect(existsSync(seenPath)).toBe(false)
  })

  it('refuses a host whose destroy is already in flight', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, {
      contextMenuItems: fixture.recipe.contextMenuItems,
      status: 'cleanup_pending',
      cleanupStatus: 'running'
    })

    await expect(run(fixture)).rejects.toThrow(
      'This host is released or being removed, so its context menu actions are gone.'
    )
    expect(existsSync(seenPath)).toBe(false)
  })

  it('refuses a click that arrives without a workspace path, without running anything', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    await expect(run(fixture, 'launch-vnc', '   ')).rejects.toThrow(
      'A context menu item needs the workspace path to run against.'
    )
    expect(existsSync(seenPath)).toBe(false)
  })

  it('refuses a click whose workspace path is not a string', async () => {
    const fixture = makeFixture()
    const { command, seenPath } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a buggy caller can send anything over IPC, which is the case this guard exists for.
    const workspacePath = 42 as unknown as string

    await expect(run(fixture, 'launch-vnc', workspacePath)).rejects.toThrow(
      'A context menu item needs the workspace path to run against.'
    )
    expect(existsSync(seenPath)).toBe(false)
  })

  it('keeps stdout and stderr off the IPC result', async () => {
    const fixture = makeFixture()
    const { command } = writeItemScript(fixture.repoPath, 'launch-vnc')
    fixture.recipe.contextMenuItems = [{ id: 'launch-vnc', label: 'Launch VNC', command }]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    // Why: the renderer shows a toast, so the raw streams (which can carry tokens) stay in main.
    expect(Object.keys(await run(fixture))).toEqual([
      'runtimeId',
      'itemId',
      'itemLabel',
      'hostName',
      'workspacePath'
    ])
  })

  it('refuses an item the host does not declare, without running anything', async () => {
    const fixture = makeFixture()
    seedRuntime(fixture, { contextMenuItems: [] })

    await expect(run(fixture, 'launch-serial')).rejects.toThrow(
      'Recipe "team-machine" does not declare the context menu item "launch-serial".'
    )
  })

  it('surfaces the script’s own failure text, not just its exit code', async () => {
    const fixture = makeFixture()
    const scriptPath = join(fixture.repoPath, 'launch-vnc.js')
    writeFileSync(
      scriptPath,
      'console.error("vncviewer: connection refused by node-9f2c"); process.exit(4)'
    )
    fixture.recipe.contextMenuItems = [
      { id: 'launch-vnc', label: 'Launch VNC', command: nodeCommand(scriptPath) }
    ]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    await expect(run(fixture)).rejects.toThrow(
      'Context menu item "Launch VNC" exited with code 4. vncviewer: connection refused by node-9f2c'
    )
  })

  it('reports only the exit code when the script said nothing', async () => {
    const fixture = makeFixture()
    const scriptPath = join(fixture.repoPath, 'silent.js')
    writeFileSync(scriptPath, 'process.exit(5)')
    fixture.recipe.contextMenuItems = [
      { id: 'launch-vnc', label: 'Launch VNC', command: nodeCommand(scriptPath) }
    ]
    seedRuntime(fixture, { contextMenuItems: fixture.recipe.contextMenuItems })

    await expect(run(fixture)).rejects.toThrow('Context menu item "Launch VNC" exited with code 5.')
  })
})

describe('resolveEphemeralVmRuntimeHostName', () => {
  it('uses the recipe-published SSH label, which is where a node id lives', () => {
    expect(resolveEphemeralVmRuntimeHostName('/unused', baseRuntime())).toBe('node-9f2c')
  })

  it('uses the registered environment name for an Orca-server host', () => {
    mocks.listEnvironments.mockReturnValue([{ id: 'env-1', name: 'Team machine (repo)' }])

    expect(
      resolveEphemeralVmRuntimeHostName(
        '/unused',
        baseRuntime({
          connectionMode: 'orca-server',
          runtimeEnvironmentId: 'env-1',
          recipeResult: {
            schemaVersion: 1,
            pairingCode: 'pair-1',
            projectRoot: '/workspace/repo'
          }
        })
      )
    ).toBe('Team machine (repo)')
  })

  it('is empty when an Orca-server host has no environment to name it', () => {
    expect(
      resolveEphemeralVmRuntimeHostName(
        '/unused',
        baseRuntime({
          connectionMode: 'orca-server',
          recipeResult: {
            schemaVersion: 1,
            pairingCode: 'pair-1',
            projectRoot: '/workspace/repo'
          }
        })
      )
    ).toBe('')
  })

  it('is empty rather than throwing when the environment store cannot be read', () => {
    mocks.listEnvironments.mockImplementation(() => {
      throw new Error('unreadable store')
    })

    expect(
      resolveEphemeralVmRuntimeHostName(
        '/unused',
        baseRuntime({
          connectionMode: 'orca-server',
          runtimeEnvironmentId: 'env-1',
          recipeResult: {
            schemaVersion: 1,
            pairingCode: 'pair-1',
            projectRoot: '/workspace/repo'
          }
        })
      )
    ).toBe('')
  })
})
