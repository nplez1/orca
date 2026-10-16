import type { Store } from './persistence'
import {
  isEphemeralVmHostActionable,
  type EphemeralVmRuntimeRecord
} from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import { listEnvironments } from '../shared/runtime-environment-store'
import { getRuntimeRecipeContext } from './ipc/ephemeral-vm-recipe-context'
import {
  runEphemeralVmRecipeContextMenuItem,
  type EphemeralVmRuntimeContextMenuItemRun
} from '../shared/ephemeral-vm-recipe-context-menu-runner'
import { contextFromRuntime } from './ephemeral-vm-runtime-service'

export type RunEphemeralVmRuntimeContextMenuItemArgs = {
  userDataPath: string
  store: Store
  runtimeId: string
  /** The declared item the user clicked, by id. */
  itemId: string
  /** The workspace's path as its own row carries it; the caller is the surface that has the row. */
  workspacePath: string
  signal?: AbortSignal
}

/**
 * Run one recipe-declared context-menu item against a workspace's host.
 *
 * Why only an id crosses the IPC boundary: the command it maps to is resolved from the recipe
 * snapshot on the runtime record, so a click can only ever run a script this host's recipe declared
 * when it was created — never one named by the caller.
 */
export async function runEphemeralVmRuntimeContextMenuItem(
  args: RunEphemeralVmRuntimeContextMenuItemArgs
): Promise<EphemeralVmRuntimeContextMenuItemRun> {
  const resolved = getRuntimeRecipeContext(args.store, args.userDataPath, args.runtimeId)
  const runtime = resolved.runtime
  // Why the same predicate the menu hides on: an action the user can see must either run or explain
  // itself, and a released host — or one whose destroy is in flight — is not somewhere to launch into.
  if (!isEphemeralVmHostActionable(runtime)) {
    throw new Error('This host is released or being removed, so its context menu actions are gone.')
  }
  const workspacePath = typeof args.workspacePath === 'string' ? args.workspacePath.trim() : ''
  if (!workspacePath) {
    throw new Error('A context menu item needs the workspace path to run against.')
  }

  const hostName = resolveEphemeralVmRuntimeHostName(args.userDataPath, runtime)

  const run = await runEphemeralVmRecipeContextMenuItem({
    repoPath: resolved.repo.repo.path,
    // Why the record first: the hook that runs for a click is the one the recipe declared when
    // this host was created, so a later orca.yaml edit cannot redirect an existing workspace's menu.
    // Why no fallback to the recipe read now: the renderer only offers what the record holds, so a
    // recipe the host never snapshotted was never offered — and main must accept exactly what the
    // menu shows.
    recipe: { ...resolved.recipe, contextMenuItems: runtime.contextMenuItems ?? [] },
    context: contextFromRuntime(resolved.repo.repo.path, runtime),
    recipeResult: runtime.recipeResult,
    itemId: args.itemId,
    hostName,
    workspacePath,
    ...(args.signal ? { signal: args.signal } : {})
  })
  if (!run.ok) {
    // Why the runner's message: it holds the resolved declaration, so it is the side that can say
    // whether the recipe declares this item at all.
    throw new Error(run.error)
  }

  return {
    runtimeId: runtime.id,
    itemId: run.item.id,
    itemLabel: run.item.label,
    hostName,
    workspacePath
  }
}

/**
 * The name Orca holds for a workspace's host.
 *
 * A recipe names its host where it already has to: the SSH connection's `label` is the recipe's own
 * string, so a node-hosting service publishes its node id there. An Orca-server host instead has the
 * name Orca registered its environment under, which is the only name that host has.
 */
export function resolveEphemeralVmRuntimeHostName(
  userDataPath: string,
  runtime: EphemeralVmRuntimeRecord
): string {
  const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
  if (connection.type === 'ssh') {
    return connection.target.label
  }
  if (!runtime.runtimeEnvironmentId) {
    return ''
  }
  try {
    return (
      listEnvironments(userDataPath).find((entry) => entry.id === runtime.runtimeEnvironmentId)
        ?.name ?? ''
    )
  } catch {
    // Why not fatal: an unreadable environment store costs the callback a label, and the item the
    // user clicked may not need one. Refusing to run it would be the larger surprise.
    return ''
  }
}
