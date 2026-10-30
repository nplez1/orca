import { parseEphemeralVmRecipeResult, type EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeCheckoutModeError,
  getEphemeralVmRecipeResultSchemaVersion
} from './ephemeral-vm-recipe-checkout-mode'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import { buildEphemeralVmRecipeExtendPayload } from './ephemeral-vm-recipe-lifecycle-payload'
import {
  validateRepoPath,
  type EphemeralVmRecipeContext,
  type EphemeralVmRecipeLifecycleArgs
} from './ephemeral-vm-recipe-runner'

/**
 * The `extend` lifecycle action, split from the runner because it is the one action whose result
 * replaces the stored connection rather than completing a teardown.
 */

export type EphemeralVmRecipeExtendArgs = EphemeralVmRecipeLifecycleArgs & {
  /** The lifetime the caller wants, already validated against the recipe's own
   *  `extendDurations` so Orca never asks a provider for something it will refuse. */
  lifetime: string
}

/**
 * An extension has no "nothing to do" outcome: either the provider granted a new deadline or the
 * caller gets an error it can show and retry.
 */
export type EphemeralVmRecipeExtendResult =
  | {
      ok: true
      context: EphemeralVmRecipeContext
      result: EphemeralVmRecipeResult
      stdout: string
      stderr: string
    }
  | {
      ok: false
      context: EphemeralVmRecipeContext
      error: string
      stdout: string
      stderr: string
      exitCode: number | null
      signal: NodeJS.Signals | null
      /** Set when the caller's signal stopped the hook (deadline or cancel) before it answered. */
      aborted?: true
      recipeResult?: EphemeralVmRecipeResult
    }

export async function runEphemeralVmRecipeExtend(
  args: EphemeralVmRecipeExtendArgs
): Promise<EphemeralVmRecipeExtendResult> {
  validateRepoPath(args.repoPath)
  // Why an error and not a skip: the user asked for a longer lease, so a hook that quietly did
  // nothing would report success while the deadline stayed exactly where it was.
  if (!args.recipe.extend) {
    return {
      ok: false,
      context: args.context,
      error: `Recipe "${args.recipe.id}" does not declare extend.`,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null
    }
  }

  const payload = buildEphemeralVmRecipeExtendPayload({ ...args, lifetime: args.lifetime })
  const processResult = await runRecipeCommand({
    command: args.recipe.extend,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'extend',
    resultSchemaVersion: getEphemeralVmRecipeResultSchemaVersion(args.recipe),
    stdin: `${JSON.stringify(payload)}\n`,
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      context: args.context,
      // Why the abort case is folded in here rather than checked first: a hook that was killed reports no
      // code, but one that finished and printed a result was not killed — even if the caller's deadline
      // landed microseconds later, and throwing that answer away would discard a granted extension.
      error: processResult.aborted
        ? 'Extend was stopped before it reported a result.'
        : `Extend exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  const parsed = parseEphemeralVmRecipeResult(processResult.stdout)
  if (!parsed.ok) {
    return { ok: false, context: args.context, error: parsed.error, ...processResult }
  }
  const checkoutModeError = getEphemeralVmRecipeCheckoutModeError(args.recipe, parsed.result)
  if (checkoutModeError) {
    return {
      ok: false,
      context: args.context,
      error: checkoutModeError,
      recipeResult: parsed.result,
      ...processResult
    }
  }

  return {
    ok: true,
    context: args.context,
    result: parsed.result,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  }
}
