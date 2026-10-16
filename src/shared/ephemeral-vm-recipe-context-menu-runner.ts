import type { OrcaVmRecipeContextMenuItem } from './orca-yaml-hook-types'
import { getEphemeralVmRecipeResultSchemaVersion } from './ephemeral-vm-recipe-checkout-mode'
import { redactEphemeralVmRecipeDiagnosticText } from './ephemeral-vm-recipe-diagnostics'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import { buildEphemeralVmRecipeContextMenuPayload } from './ephemeral-vm-recipe-lifecycle-payload'
import {
  validateRepoPath,
  type EphemeralVmRecipeContext,
  type EphemeralVmRecipeLifecycleArgs
} from './ephemeral-vm-recipe-runner'

/**
 * The `context-menu` action: one declared item, run with the workspace's identity.
 *
 * Split from the lifecycle runner because it is the only action the user starts from the workspace
 * rather than from a lease or a teardown, and the only one that is not a lifecycle transition.
 */

export type EphemeralVmRecipeContextMenuItemArgs = EphemeralVmRecipeLifecycleArgs & {
  /** The declared item the user clicked, by id. */
  itemId: string
  /** The name Orca holds for the workspace's host; empty when it has none. */
  hostName: string
  /** The workspace's path as its own row carries it — the path on the host that runs it. */
  workspacePath: string
}

export type EphemeralVmRecipeContextMenuItemResult =
  | {
      ok: true
      context: EphemeralVmRecipeContext
      item: OrcaVmRecipeContextMenuItem
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
    }

export async function runEphemeralVmRecipeContextMenuItem(
  args: EphemeralVmRecipeContextMenuItemArgs
): Promise<EphemeralVmRecipeContextMenuItemResult> {
  validateRepoPath(args.repoPath)
  // Why an error and not a skip: the user clicked an item Orca itself offered, so silently
  // succeeding would report an action that never ran.
  const item = (args.recipe.contextMenuItems ?? []).find((entry) => entry.id === args.itemId)
  if (!item) {
    return {
      ok: false,
      context: args.context,
      error: `Recipe "${args.recipe.id}" does not declare the context menu item "${args.itemId}".`,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null
    }
  }

  const payload = buildEphemeralVmRecipeContextMenuPayload({
    recipe: args.recipe,
    context: args.context,
    recipeResult: args.recipeResult,
    item,
    hostName: args.hostName,
    workspacePath: args.workspacePath
  })
  // Why the caller's env carries them: `runRecipeCommand` applies the shared `ORCA_*` variables
  // after `env`, so a value published here could only be shadowed by a name that set does not use.
  // The end-to-end test asserts all five arrive, which is what turns that into an invariant.
  const env = {
    ...args.env,
    ...buildContextMenuEnv({ item, hostName: args.hostName, workspacePath: args.workspacePath })
  }
  const processResult = await runRecipeCommand({
    command: item.command,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'context-menu',
    resultSchemaVersion: getEphemeralVmRecipeResultSchemaVersion(args.recipe),
    stdin: `${JSON.stringify(payload)}\n`,
    env,
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
      error: describeContextMenuItemFailure({
        item,
        exitCode: processResult.exitCode,
        stderr: processResult.stderr
      }),
      ...processResult
    }
  }

  // Why no stdout contract: an item launches something (a viewer, a tunnel, a provider call), so
  // there is no recipe result to parse — exit 0 is the whole answer.
  return { ok: true, context: args.context, item, ...processResult }
}

/**
 * What a completed run reports back to the renderer: which item ran, and the workspace identity it
 * was handed. Declared in `shared` so the preload API can name it without reaching into `main`.
 *
 * Why no captured output: the renderer shows a toast and nothing else, and a failure's own text is
 * already in the error it reported — carrying the raw streams would ship provider output, tokens and
 * all, across the IPC boundary for nobody to read.
 */
export type EphemeralVmRuntimeContextMenuItemRun = {
  runtimeId: string
  itemId: string
  itemLabel: string
  /** The name Orca holds for the workspace's host; empty when it has none. */
  hostName: string
  /** The workspace's path as its own row carries it — the path on the host that runs it. */
  workspacePath: string
}

/** How much of the script's own failure text a toast can carry before it stops being a toast. */
const MAX_FAILURE_DETAIL_CHARS = 300

/**
 * The failure a click reports: what exited, plus the script's own last word on why.
 *
 * Why the stderr tail: this message is the only thing the user sees — the toast shows it verbatim —
 * and an exit code alone says nothing about which machine, host or credential refused. Redacted
 * first because a provider CLI happily prints tokens to stderr.
 */
export function describeContextMenuItemFailure(args: {
  item: Pick<OrcaVmRecipeContextMenuItem, 'label'>
  exitCode: number | null
  stderr: string
}): string {
  const exit = `Context menu item "${args.item.label}" exited with code ${args.exitCode ?? 'unknown'}.`
  const detail = redactEphemeralVmRecipeDiagnosticText(args.stderr)
    .split('\n')
    .map((line) => line.trim())
    .findLast(Boolean)
  return detail ? `${exit} ${detail.slice(0, MAX_FAILURE_DETAIL_CHARS)}` : exit
}

/** The three values the callback exists for, plus the two that identify which item asked. */
export function buildContextMenuEnv(args: {
  item: Pick<OrcaVmRecipeContextMenuItem, 'id' | 'label'>
  hostName: string
  workspacePath: string
}): NodeJS.ProcessEnv {
  return {
    ORCA_HOST_NAME: args.hostName,
    ORCA_WORKSPACE_PATH: args.workspacePath,
    ORCA_CONTEXT_MENU_ITEM_ID: args.item.id,
    ORCA_CONTEXT_MENU_ITEM_LABEL: args.item.label
  }
}
