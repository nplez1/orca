import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  getEphemeralVmLifetimeLossError,
  getEphemeralVmRecipeResultLifetime,
  getEphemeralVmRecipeResultPairingCode,
  parseEphemeralVmRecipeResult,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'
import { redactEphemeralVmRecipeDiagnosticText } from '../shared/ephemeral-vm-recipe-diagnostics'
import { normalizeEphemeralVmLifetimeDuration } from '../shared/ephemeral-vm-lifetime'
import { runEphemeralVmRecipeExtend } from '../shared/ephemeral-vm-recipe-extend-runner'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'

/**
 * Provider-author path for the `extend` hook: run it against a saved recipe result without the
 * desktop app, so a script can be exercised end to end before it is wired into a live lease.
 *
 * The desktop surface (workspace context menu, runtime settings) is what updates persisted
 * metadata; this only reports what the hook produced.
 */

const MAX_TRANSCRIPT_BYTES = 16_000

/**
 * How long a hook may run before the command gives up.
 *
 * Why bounded by default: a command scripts call has to terminate, and a hook waiting on a provider
 * CLI for an authentication prompt would otherwise hang the caller with no output at all.
 */
export const DEFAULT_EXTEND_TIMEOUT_MS = 120_000
/**
 * The ceiling, not a suggestion: a hook that needs longer than this is stuck rather than slow, and an
 * unbounded wait is the defect the deadline exists to remove.
 */
export const MAX_EXTEND_TIMEOUT_MS = 3_600_000

export type ExtendTimeoutVerdict = { ok: true; timeoutMs: number } | { ok: false; error: string }

/** Validates `--timeout-ms` so an out-of-range value is refused instead of quietly ignored. */
export function resolveExtendTimeoutMs(requested: number | undefined): ExtendTimeoutVerdict {
  if (requested === undefined) {
    return { ok: true, timeoutMs: DEFAULT_EXTEND_TIMEOUT_MS }
  }
  if (!Number.isInteger(requested) || requested <= 0) {
    return { ok: false, error: '--timeout-ms must be a positive whole number of milliseconds.' }
  }
  if (requested > MAX_EXTEND_TIMEOUT_MS) {
    return {
      ok: false,
      error: `--timeout-ms must be at most ${MAX_EXTEND_TIMEOUT_MS} ms; a hook slower than that is stuck.`
    }
  }
  return { ok: true, timeoutMs: requested }
}

export type ExtendEphemeralVmRecipeTranscript = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type ExtendEphemeralVmRecipeResult = {
  recipeId: string
  repoPath: string
  ok: boolean
  requestedLifetime?: string
  /** The deadline the hook reported, so a caller can confirm it moved. */
  releaseAt?: string
  recipeResult?: EphemeralVmRecipeResult
  offeredLifetimes?: string[]
  error?: string
  transcript?: ExtendEphemeralVmRecipeTranscript
}

export async function extendEphemeralVmRecipeFromFile(args: {
  repoPath: string
  recipe: OrcaVmRecipe
  recipeResultPath: string
  requestedLifetime: string
  /** Defaults to {@link DEFAULT_EXTEND_TIMEOUT_MS}, so no caller can run the hook unbounded. */
  timeoutMs?: number
}): Promise<ExtendEphemeralVmRecipeResult> {
  const base = { recipeId: args.recipe.id, repoPath: args.repoPath }
  const timeout = resolveExtendTimeoutMs(args.timeoutMs)
  if (!timeout.ok) {
    return { ...base, ok: false, error: timeout.error }
  }
  const lifetime = normalizeEphemeralVmLifetimeDuration(args.requestedLifetime)
  if (!lifetime) {
    return {
      ...base,
      ok: false,
      error: `"${args.requestedLifetime}" is not a duration such as 4h or 1d.`
    }
  }
  if (!args.recipe.extend) {
    return { ...base, ok: false, error: `Recipe "${args.recipe.id}" does not declare extend.` }
  }
  const offered = args.recipe.extendDurations ?? []
  if (!offered.includes(lifetime)) {
    return {
      ...base,
      ok: false,
      offeredLifetimes: offered,
      error: `Recipe "${args.recipe.id}" does not offer the lifetime "${lifetime}".`
    }
  }
  if (!existsSync(args.recipeResultPath)) {
    return { ...base, ok: false, error: `No recipe result file at ${args.recipeResultPath}.` }
  }
  const parsed = parseEphemeralVmRecipeResult(readFileSync(args.recipeResultPath, 'utf8'))
  if (!parsed.ok) {
    return { ...base, ok: false, error: `Recipe result file is not valid. ${parsed.error}` }
  }

  // Why the deadline even though this command is not interruptible: a hook blocked on the network or
  // on a provider CLI's authentication prompt hangs the caller forever, and a script cannot recover.
  const signal = AbortSignal.timeout(timeout.timeoutMs)
  const extend = await runEphemeralVmRecipeExtend({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: { recipeId: args.recipe.id, repoPath: args.repoPath },
    recipeResult: parsed.result,
    lifetime,
    signal
  })
  if (!extend.ok) {
    return {
      ...base,
      ok: false,
      requestedLifetime: lifetime,
      // Why its own message: the hook was killed, not refused, so the transcript alone would read as an
      // unexplained empty exit and the caller would not know the provider may have acted already.
      error: extend.aborted
        ? `Extend did not finish within ${timeout.timeoutMs} ms and was stopped. The provider may already have granted the extension, so check its own deadline before extending again.`
        : extend.error,
      transcript: {
        exitCode: extend.exitCode,
        signal: extend.signal,
        stdout: redactAndCap(extend.stdout),
        stderr: redactAndCap(extend.stderr)
      }
    }
  }

  // Same guard as the app, and for the same reason: an answer that loses the deadline would leave a
  // lease with no countdown and no reconciliation. Refusing costs nothing here — the caller still
  // holds the result it passed in.
  const lostLifetimeError = getEphemeralVmLifetimeLossError(parsed.result, extend.result, 'Extend')
  if (lostLifetimeError) {
    // Why the transcript travels with this refusal too: the hook succeeded but its answer was
    // unusable, so its stdout is the only thing that shows the typo.
    return {
      ...base,
      ok: false,
      requestedLifetime: lifetime,
      error: lostLifetimeError,
      transcript: {
        // The run itself succeeded — it is the answer that was unusable — so exit 0 / no signal.
        exitCode: 0,
        signal: null,
        stdout: redactAndCap(extend.stdout),
        stderr: redactAndCap(extend.stderr)
      }
    }
  }
  const extended = getEphemeralVmRecipeResultLifetime(extend.result)
  return {
    ...base,
    ok: true,
    requestedLifetime: lifetime,
    recipeResult: extend.result,
    ...(extended.ok && extended.lifetime ? { releaseAt: extended.lifetime.releaseAt } : {})
  }
}

/** `resultPath` is where `--write-result` put the updated result, so the text form reports
 *  the file instead of printing the connection it now holds. */
export function formatExtendEphemeralVmRecipeResult(
  result: ExtendEphemeralVmRecipeResult,
  options: { resultPath?: string } = {}
): string {
  const lines = [`recipe: ${result.recipeId}`, `repoPath: ${result.repoPath}`]
  if (!result.ok) {
    lines.push('ok: false', `error: ${result.error ?? 'Extend failed.'}`)
    if (result.offeredLifetimes?.length) {
      lines.push(`offered lifetimes: ${result.offeredLifetimes.join(', ')}`)
    }
    if (result.transcript) {
      const exit = result.transcript.exitCode ?? result.transcript.signal ?? 'unknown'
      lines.push(`--- extend (exit ${exit}) ---`)
      if (result.transcript.stdout.trim()) {
        lines.push(`stdout:\n${result.transcript.stdout}`)
      }
      if (result.transcript.stderr.trim()) {
        lines.push(`stderr:\n${result.transcript.stderr}`)
      }
    }
    return lines.join('\n')
  }
  lines.push('ok: true', `lifetime: ${result.requestedLifetime ?? 'unknown'}`)
  if (result.releaseAt) {
    lines.push(`releaseAt: ${result.releaseAt}`)
  }
  if (options.resultPath) {
    // Why a path and not the JSON: the file is what the destroy hook reads, and printing it here
    // as well would put the connection back on stdout.
    lines.push(`result: ${options.resultPath}`)
    return lines.join('\n')
  }
  // Why the warning: this is what the recipe's own `destroy` hook consumes on stdin, and it carries
  // the connection verbatim — a pairing code included. Printing it is the point; treating it as
  // anything but sensitive is not.
  lines.push(
    '',
    'updated recipe result (contains the connection, including any pairing code — handle as sensitive):',
    JSON.stringify(result.recipeResult, null, 2)
  )
  return lines.join('\n')
}

/** Only a result that carries the connection verbatim needs the warning, and only the
 *  `orca serve` shape carries a pairing code. */
export function describeSensitiveExtendResult(
  result: ExtendEphemeralVmRecipeResult
): string | null {
  const pairingCode =
    result.ok && result.recipeResult
      ? getEphemeralVmRecipeResultPairingCode(result.recipeResult)
      : null
  return pairingCode
    ? 'this result carries the connection, including its pairing code — handle as sensitive.'
    : null
}

/** Publishes the updated result where a destroy hook — or a second `extend` — reads it.
 *
 *  Atomic and 0600, but the file only: the shared secure-write helpers also harden the *parent*
 *  directory to 0700, which would silently lock down the repo directory the caller wrote into
 *  (and throw on a parent they do not own). The failure is returned rather than thrown, because
 *  the hook has already moved the lease and the caller still has to see what it produced.
 *
 *  Returns the failure message, or null when the file holds the result. */
export function writeEphemeralVmRecipeResultFile(
  path: string,
  result: EphemeralVmRecipeResult
): string | null {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(result, null, 2), { mode: 0o600 })
    // The umask can strip bits from `mode` but never add them; chmod sets exactly 0o600.
    chmodSync(temporary, 0o600)
    // The rename publishes the staged inode, so the mode above is the published file's.
    renameSync(temporary, path)
    return null
  } catch (error) {
    rmSync(temporary, { force: true })
    return error instanceof Error ? error.message : String(error)
  }
}

function redactAndCap(value: string): string {
  const redacted = redactEphemeralVmRecipeDiagnosticText(value)
  if (redacted.length <= MAX_TRANSCRIPT_BYTES) {
    return redacted
  }
  const half = Math.floor(MAX_TRANSCRIPT_BYTES / 2)
  const omitted = redacted.length - half * 2
  return `${redacted.slice(0, half)}\n…[${omitted} chars omitted]…\n${redacted.slice(-half)}`
}
