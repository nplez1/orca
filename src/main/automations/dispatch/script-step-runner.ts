import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { Repo } from '../../../shared/repository/repo-types'
import type { AutomationScriptStep } from '../../../shared/automations/steps/automation-steps'
import {
  boundAutomationStepOutput,
  MAX_AUTOMATION_STEP_REVIEW_CONTENT_CHARS,
  type AutomationScriptStepExecutor,
  type AutomationStepOutcome,
  type AutomationStepResult
} from '../../../shared/automations/steps/automation-step-results'
import { automationScriptStepCommand } from '../../../shared/automations/steps/automation-steps'
import { getHookCommandShellKind, runHookCommand } from '../../workspace-hooks/hooks'
import {
  getHookWslContext,
  type HookRuntimeTarget
} from '../../workspace-hooks/hook-runtime-target'
import { getSetupEnvVars } from '../../workspace-hooks/setup-hook-env-vars'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { toLinuxPath } from '../../../shared/file-access/wsl-paths'
import { errorMessage } from '../../../shared/errors/error-message'
import { automationScriptContentHash, automationScriptStepPin } from './script-step-pin'

/** Where a run's script steps execute: this host's checkout, or a host this executor cannot reach. */
export type AutomationScriptStepHost =
  | {
      type: 'local'
      cwd: string
      repo: Pick<Repo, 'path' | 'kind'>
      runtimeTarget?: HookRuntimeTarget
    }
  | { type: 'unverifiable'; error: string }

// The whole file must fit the review prompt, so what is approved is all of what runs.
const MAX_SCRIPT_FILE_BYTES = MAX_AUTOMATION_STEP_REVIEW_CONTENT_CHARS

type StepTiming = { startedAt: number }

function stepResult(
  step: AutomationScriptStep,
  timing: StepTiming,
  fields: {
    outcome: AutomationStepOutcome
    contentHash: string | null
    exitCode?: number | null
    output?: string
    stdout?: string
    error?: string | null
    reviewContent?: string
  }
): AutomationStepResult {
  const completedAt = Date.now()
  const output = boundAutomationStepOutput(fields.output ?? '')
  return {
    stepId: step.id,
    kind: 'script',
    script: step.script,
    ...(step.args?.length ? { args: [...step.args] } : {}),
    contentHash: fields.contentHash,
    outcome: fields.outcome,
    exitCode: fields.exitCode ?? null,
    output: output.output,
    outputTruncated: output.truncated,
    error: fields.error ?? null,
    startedAt: timing.startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - timing.startedAt),
    // Handoff only: normalization drops it from the persisted run.
    stdout: boundAutomationStepOutput(fields.stdout ?? '').output,
    ...(fields.reviewContent !== undefined ? { reviewContent: fields.reviewContent } : {})
  }
}

type ScriptFile = { bytes: Buffer; mode: number; path: string }

/** Reads the file the step names, refusing a symlink or path that resolves outside the project. */
async function readScriptFile(
  cwd: string,
  script: string
): Promise<ScriptFile | { error: string }> {
  try {
    const root = await realpath(windowsFsPath(cwd))
    const path = await realpath(windowsFsPath(join(cwd, script)))
    const inside = relative(root, path)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      return { error: 'the path resolves outside the project checkout.' }
    }
    const info = await stat(path)
    if (!info.isFile()) {
      return { error: 'the path is not a file in the project.' }
    }
    if (info.size > MAX_SCRIPT_FILE_BYTES) {
      return { error: 'the file is larger than 64 KB, too large to review.' }
    }
    return { bytes: await readFile(path), mode: info.mode & 0o777, path }
  } catch (error) {
    return {
      error:
        error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 'the file does not exist in the project checkout.'
          : errorMessage(error)
    }
  }
}

/** Runs a private copy of the verified bytes, so a write between check and exec cannot swap them. */
async function withVerifiedCopy<T>(
  file: ScriptFile,
  run: (copy: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-step-'))
  try {
    const copy = join(dir, basename(file.path))
    await writeFile(copy, file.bytes, { mode: 0o700 })
    await chmod(copy, file.mode)
    return await run(copy)
  } finally {
    // A cut-off step on Windows can still hold the file; the temp dir is left for the OS then.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Runs each script step through the hook executor on the automation's host, after checking its
 * path, arguments and bytes against the pin the user approved on this host.
 */
export function createAutomationScriptStepExecutor(
  host: AutomationScriptStepHost
): AutomationScriptStepExecutor {
  return async (step, handoffEnv) => {
    const timing = { startedAt: Date.now() }
    if (host.type === 'unverifiable') {
      return stepResult(step, timing, {
        outcome: 'unverifiable',
        contentHash: null,
        error: host.error
      })
    }
    const file = await readScriptFile(host.cwd, step.script)
    if ('error' in file) {
      return stepResult(step, timing, {
        outcome: 'unverifiable',
        contentHash: null,
        error: `${step.script}: ${file.error}`
      })
    }
    const contentHash = automationScriptContentHash(file.bytes)
    if (step.approvedPin !== automationScriptStepPin(step, file.bytes)) {
      return stepResult(step, timing, {
        outcome: 'unapproved',
        contentHash,
        reviewContent: file.bytes.toString('utf8')
      })
    }
    const wsl = getHookWslContext(host.cwd, host.runtimeTarget)
    return withVerifiedCopy(file, async (copy) => {
      const command = automationScriptStepCommand(
        wsl ? toLinuxPath(copy) : copy,
        step.args,
        getHookCommandShellKind(host.cwd, host.runtimeTarget)
      )
      if (!command.ok) {
        return stepResult(step, timing, {
          outcome: 'unverifiable',
          contentHash,
          error: `${step.script}: ${command.error}`
        })
      }
      const outcome = await runHookCommand({
        hookName: `automation step ${step.id}`,
        script: command.command,
        cwd: host.cwd,
        // The copy is what runs; a script that needs its own directory reads the original's path.
        pathEnv: {
          ...getSetupEnvVars(host.repo, host.cwd),
          ORCA_AUTOMATION_STEP_SCRIPT: file.path
        },
        env: { ...handoffEnv, ORCA_AUTOMATION_STEP_ID: step.id },
        runtimeTarget: host.runtimeTarget,
        timeoutMs: step.timeoutSeconds * 1000
      })
      return stepResult(step, timing, {
        // Timeout first: the exit code of something we stopped is not evidence it finished (#19334).
        outcome: outcome.timedOut ? 'cut_off' : outcome.success ? 'succeeded' : 'failed',
        contentHash,
        exitCode: outcome.timedOut ? null : outcome.success ? 0 : (outcome.exitCode ?? null),
        output: outcome.output,
        stdout: outcome.stdout ?? ''
      })
    })
  }
}
