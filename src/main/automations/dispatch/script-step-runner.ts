import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
import type { HookRuntimeTarget } from '../../workspace-hooks/hook-runtime-target'
import { getSetupEnvVars } from '../../workspace-hooks/setup-hook-env-vars'
import { hashOrcaHookTrustContent } from '../../workspace-hooks/created-worktree-setup-trust'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { errorMessage } from '../../../shared/errors/error-message'

/** Where a run's script steps execute: this host's checkout, or a host this executor cannot reach. */
export type AutomationScriptStepHost =
  | {
      type: 'local'
      cwd: string
      repo: Pick<Repo, 'path' | 'kind'>
      runtimeTarget?: HookRuntimeTarget
    }
  | { type: 'unverifiable'; error: string }

// The whole file must fit the review prompt, so what is approved is what runs.
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

async function readScriptFile(path: string): Promise<{ content: string } | { error: string }> {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return { error: 'the path is not a file in the project.' }
    }
    if (info.size > MAX_SCRIPT_FILE_BYTES) {
      return { error: 'the file is larger than 64 KB, too large to review.' }
    }
    return { content: await readFile(path, 'utf8') }
  } catch (error) {
    return {
      error:
        error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 'the file does not exist in the project checkout.'
          : errorMessage(error)
    }
  }
}

/**
 * Runs each script step through the hook executor on the automation's host, after checking the
 * file's content against the hash approved through the hook trust prompt.
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
    const file = await readScriptFile(windowsFsPath(join(host.cwd, step.script)))
    if ('error' in file) {
      return stepResult(step, timing, {
        outcome: 'unverifiable',
        contentHash: null,
        error: `${step.script}: ${file.error}`
      })
    }
    const contentHash = hashOrcaHookTrustContent(file.content)
    if (step.approvedContentHash !== contentHash) {
      return stepResult(step, timing, {
        outcome: 'unapproved',
        contentHash,
        reviewContent: file.content
      })
    }
    const outcome = await runHookCommand({
      hookName: `automation step ${step.id}`,
      script: automationScriptStepCommand(
        step,
        getHookCommandShellKind(host.cwd, host.runtimeTarget)
      ),
      cwd: host.cwd,
      pathEnv: getSetupEnvVars(host.repo, host.cwd),
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
  }
}
