import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import { quoteShellToken } from './ephemeral-vm-recipe-process'
import type { OrcaVmRecipe, OrcaVmRecipeContextMenuItem } from './orca-yaml-hook-types'

export type EphemeralVmRecipeLifecycleMode =
  | 'suspend'
  | 'resume'
  | 'destroy'
  | 'extend'
  | 'context-menu'

export type EphemeralVmRecipeLifecyclePayload = {
  schemaVersion: 1
  mode: EphemeralVmRecipeLifecycleMode
  recipeId: string
  instanceId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  recipeResult: EphemeralVmRecipeResult
  /** The lifetime the provider is being asked for, in the canonical `<count><unit>`
   *  form. Present only for `extend`, where it is the whole point of the call. */
  lifetime?: string
  /** `context-menu` only: the name Orca holds for the host this workspace runs on, which for a
   *  node-hosting recipe is the node id it published as the connection's label. */
  hostName?: string
  /** `context-menu` only: the workspace's path on its host, as the workspace's own row carries it. */
  workspacePath?: string
  /** `context-menu` only: the id of the clicked item, as declared in the recipe's
   *  `contextMenuItems`. */
  itemId?: string
  /** `context-menu` only: the label the user clicked, so a script that handles several items can
   *  log what ran. */
  itemLabel?: string
}

export function buildEphemeralVmRecipeCleanupPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeLifecyclePayload {
  return buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'destroy' })
}

export function buildEphemeralVmRecipeLifecyclePayload(args: {
  mode: EphemeralVmRecipeLifecycleMode
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeLifecyclePayload {
  return {
    schemaVersion: 1,
    mode: args.mode,
    recipeId: args.recipe.id,
    instanceId: args.context.instanceId,
    projectId: args.context.projectId,
    workspaceId: args.context.workspaceId,
    workspaceName: args.context.workspaceName,
    recipeResult: args.recipeResult
  }
}

export function buildEphemeralVmRecipeExtendPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
  lifetime: string
}): EphemeralVmRecipeLifecyclePayload {
  return {
    ...buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'extend' }),
    lifetime: args.lifetime
  }
}

/**
 * The callback a declared context-menu item is invoked with, built from the workspace's host
 * identity plus the clicked item.
 *
 * Why the values ride in the payload as well as the environment: a shell script reads `$ORCA_*`
 * directly, while a Node or Python script can parse the one JSON line instead of reassembling the
 * workspace identity from several variables.
 */
export function buildEphemeralVmRecipeContextMenuPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
  item: Pick<OrcaVmRecipeContextMenuItem, 'id' | 'label'>
  hostName: string
  workspacePath: string
}): EphemeralVmRecipeLifecyclePayload {
  return {
    ...buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'context-menu' }),
    hostName: args.hostName,
    workspacePath: args.workspacePath,
    itemId: args.item.id,
    itemLabel: args.item.label
  }
}

export function buildEphemeralVmRecipeCleanupCommand(args: {
  destroyCommand: string
  payload: EphemeralVmRecipeLifecyclePayload
}): string {
  const payloadBase64 = Buffer.from(`${JSON.stringify(args.payload)}\n`, 'utf8').toString('base64')
  return [
    'node',
    '-e',
    quoteShellToken(
      `process.stdout.write(Buffer.from(${JSON.stringify(payloadBase64)}, 'base64').toString('utf8'))`
    ),
    '|',
    args.destroyCommand
  ].join(' ')
}
