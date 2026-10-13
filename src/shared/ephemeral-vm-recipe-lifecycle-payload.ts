import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import { quoteShellToken } from './ephemeral-vm-recipe-process'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'

export type EphemeralVmRecipeLifecycleMode = 'suspend' | 'resume' | 'destroy' | 'extend'

export type EphemeralVmRecipeCleanupPayload = {
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
}

export function buildEphemeralVmRecipeCleanupPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeCleanupPayload {
  return buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'destroy' })
}

export function buildEphemeralVmRecipeLifecyclePayload(args: {
  mode: EphemeralVmRecipeLifecycleMode
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeCleanupPayload {
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
}): EphemeralVmRecipeCleanupPayload {
  return {
    ...buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'extend' }),
    lifetime: args.lifetime
  }
}

export function buildEphemeralVmRecipeCleanupCommand(args: {
  destroyCommand: string
  payload: EphemeralVmRecipeCleanupPayload
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
