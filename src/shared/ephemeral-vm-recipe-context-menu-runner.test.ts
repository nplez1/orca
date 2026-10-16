import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'
import {
  buildContextMenuEnv,
  describeContextMenuItemFailure,
  runEphemeralVmRecipeContextMenuItem
} from './ephemeral-vm-recipe-context-menu-runner'

const tmpRoots: string[] = []

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRepo(scriptSource: string): { repoPath: string; scriptPath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-context-menu-'))
  tmpRoots.push(repoPath)
  const scriptPath = join(repoPath, 'launch.js')
  writeFileSync(scriptPath, scriptSource)
  return { repoPath, scriptPath }
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function recipe(command: string): OrcaVmRecipe {
  return {
    id: 'team-machine',
    name: 'Team machine',
    create: './create.sh',
    contextMenuItems: [
      { id: 'launch-vnc', label: 'Launch VNC', command },
      { id: 'launch-rdp', label: 'Launch RDP', command }
    ]
  }
}

const RECIPE_RESULT = {
  schemaVersion: 1 as const,
  pairingCode: 'pair-1',
  projectRoot: '/workspace/repo'
}

describe('runEphemeralVmRecipeContextMenuItem', () => {
  it('runs the clicked item with the workspace identity, in env and on stdin', async () => {
    // Echo the whole callback back on stderr: it is the contract the item's script consumes.
    const { repoPath, scriptPath } = makeRepo(
      [
        'let payload = ""',
        'process.stdin.on("data", (chunk) => { payload += chunk })',
        'process.stdin.on("end", () => {',
        '  console.error(JSON.stringify({',
        '    mode: process.env.ORCA_VM_MODE,',
        '    hostName: process.env.ORCA_HOST_NAME,',
        '    workspaceName: process.env.ORCA_WORKSPACE_NAME,',
        '    workspacePath: process.env.ORCA_WORKSPACE_PATH,',
        '    itemId: process.env.ORCA_CONTEXT_MENU_ITEM_ID,',
        '    itemLabel: process.env.ORCA_CONTEXT_MENU_ITEM_LABEL,',
        '    payload: JSON.parse(payload)',
        '  }))',
        '})'
      ].join('\n')
    )

    const result = await runEphemeralVmRecipeContextMenuItem({
      repoPath,
      recipe: recipe(nodeCommand(scriptPath)),
      context: {
        recipeId: 'team-machine',
        instanceId: 'orca-1',
        workspaceId: 'repo::ws-1',
        workspaceName: 'Fix Login Race',
        repoPath
      },
      recipeResult: RECIPE_RESULT,
      itemId: 'launch-vnc',
      hostName: 'node-9f2c',
      workspacePath: '/workspace/repo'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.item).toEqual({
      id: 'launch-vnc',
      label: 'Launch VNC',
      command: nodeCommand(scriptPath)
    })
    const observed = JSON.parse(result.stderr.trim())
    expect(observed).toEqual({
      mode: 'context-menu',
      hostName: 'node-9f2c',
      workspaceName: 'Fix Login Race',
      workspacePath: '/workspace/repo',
      itemId: 'launch-vnc',
      itemLabel: 'Launch VNC',
      payload: {
        schemaVersion: 1,
        mode: 'context-menu',
        recipeId: 'team-machine',
        instanceId: 'orca-1',
        workspaceId: 'repo::ws-1',
        workspaceName: 'Fix Login Race',
        recipeResult: RECIPE_RESULT,
        hostName: 'node-9f2c',
        workspacePath: '/workspace/repo',
        itemId: 'launch-vnc',
        itemLabel: 'Launch VNC'
      }
    })
  })

  it('runs only the item that was clicked', async () => {
    const { repoPath, scriptPath } = makeRepo('console.error("ran")')
    const both = recipe(nodeCommand(scriptPath))
    both.contextMenuItems = [
      { id: 'launch-vnc', label: 'Launch VNC', command: 'exit 7' },
      { id: 'launch-rdp', label: 'Launch RDP', command: nodeCommand(scriptPath) }
    ]

    const result = await runEphemeralVmRecipeContextMenuItem({
      repoPath,
      recipe: both,
      context: { recipeId: 'team-machine', repoPath },
      recipeResult: RECIPE_RESULT,
      itemId: 'launch-rdp',
      hostName: '',
      workspacePath: '/workspace/repo'
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.item.id).toBe('launch-rdp')
  })

  it('refuses an item the recipe does not declare, without running anything', async () => {
    const { repoPath, scriptPath } = makeRepo('console.error("should not run")')

    const result = await runEphemeralVmRecipeContextMenuItem({
      repoPath,
      recipe: recipe(nodeCommand(scriptPath)),
      context: { recipeId: 'team-machine', repoPath },
      recipeResult: RECIPE_RESULT,
      itemId: 'launch-serial',
      hostName: 'node-9f2c',
      workspacePath: '/workspace/repo'
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toBe(
      'Recipe "team-machine" does not declare the context menu item "launch-serial".'
    )
    expect(result.stderr).toBe('')
  })

  it('names the item, its exit code and the script’s own failure text', async () => {
    const { repoPath, scriptPath } = makeRepo(
      'console.error("starting"); console.error("no node to reach"); process.exit(3)'
    )

    const result = await runEphemeralVmRecipeContextMenuItem({
      repoPath,
      recipe: recipe(nodeCommand(scriptPath)),
      context: { recipeId: 'team-machine', repoPath },
      recipeResult: RECIPE_RESULT,
      itemId: 'launch-vnc',
      hostName: '',
      workspacePath: '/workspace/repo'
    })

    expect(result.ok).toBe(false)
    // Why the last stderr line: the toast shows this verbatim, and the script's own final word is
    // what tells the user which machine refused.
    expect(result.ok ? undefined : result.error).toBe(
      'Context menu item "Launch VNC" exited with code 3. no node to reach'
    )
    expect(result.stderr).toContain('no node to reach')
  })

  it('reports the exit code alone when the script failed silently', async () => {
    const { repoPath, scriptPath } = makeRepo('process.exit(6)')

    const result = await runEphemeralVmRecipeContextMenuItem({
      repoPath,
      recipe: recipe(nodeCommand(scriptPath)),
      context: { recipeId: 'team-machine', repoPath },
      recipeResult: RECIPE_RESULT,
      itemId: 'launch-vnc',
      hostName: '',
      workspacePath: '/workspace/repo'
    })

    expect(result.ok ? undefined : result.error).toBe(
      'Context menu item "Launch VNC" exited with code 6.'
    )
  })
})

describe('describeContextMenuItemFailure', () => {
  const item = { label: 'Launch VNC' }

  it('appends the script’s last non-empty stderr line', () => {
    expect(
      describeContextMenuItemFailure({
        item,
        exitCode: 1,
        stderr: 'connecting\nvncviewer: refused\n\n'
      })
    ).toBe('Context menu item "Launch VNC" exited with code 1. vncviewer: refused')
  })

  it('says nothing extra when stderr is empty or blank', () => {
    expect(describeContextMenuItemFailure({ item, exitCode: 1, stderr: '   \n' })).toBe(
      'Context menu item "Launch VNC" exited with code 1.'
    )
    expect(describeContextMenuItemFailure({ item, exitCode: 1, stderr: '' })).toBe(
      'Context menu item "Launch VNC" exited with code 1.'
    )
  })

  it('redacts a token the script printed', () => {
    expect(
      describeContextMenuItemFailure({
        item,
        exitCode: 1,
        stderr: '{"token":"ghp_secretvalue"}'
      })
    ).toBe('Context menu item "Launch VNC" exited with code 1. {"token":"[redacted]"}')
  })

  it('caps how much of a long line a toast carries', () => {
    const failure = describeContextMenuItemFailure({
      item,
      exitCode: 1,
      stderr: 'x'.repeat(5000)
    })

    expect(failure.length).toBeLessThan(400)
    expect(failure.startsWith('Context menu item "Launch VNC" exited with code 1. xxx')).toBe(true)
  })
})

describe('buildContextMenuEnv', () => {
  it('publishes the item identity beside the workspace values', () => {
    expect(
      buildContextMenuEnv({
        item: { id: 'launch-vnc', label: 'Launch VNC' },
        hostName: 'node-9f2c',
        workspacePath: '/workspace/repo'
      })
    ).toEqual({
      ORCA_HOST_NAME: 'node-9f2c',
      ORCA_WORKSPACE_PATH: '/workspace/repo',
      ORCA_CONTEXT_MENU_ITEM_ID: 'launch-vnc',
      ORCA_CONTEXT_MENU_ITEM_LABEL: 'Launch VNC'
    })
  })
})
