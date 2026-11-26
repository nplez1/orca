import { randomBytes } from 'node:crypto'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Repo } from '../../../shared/repository/repo-types'
import type { AutomationScriptStep } from '../../../shared/automations/steps/automation-steps'
import {
  boundAutomationStepOutput,
  MAX_AUTOMATION_STEP_REVIEW_CONTENT_CHARS,
  type AutomationScriptStepExecutor,
  type AutomationStepOutcome,
  type AutomationStepResult
} from '../../../shared/automations/steps/automation-step-results'
import { MAX_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS } from '../../../shared/automations/steps/automation-steps'
import {
  automationScriptStepCommand,
  isCopyModeFailure
} from '../../../shared/automations/steps/automation-script-step-command'
import { getHookCommandShellKind, runHookCommand } from '../../workspace-hooks/hooks'
import {
  getHookWslContext,
  type HookRuntimeTarget
} from '../../workspace-hooks/hook-runtime-target'
import { getSetupEnvVars } from '../../workspace-hooks/setup-hook-env-vars'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { toLinuxPath, wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
import { readableGitCommonDir } from '../../git/worktrees/removal/worktree-prune-guard'
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

export const AUTOMATION_STEP_COPY_PATTERN = '.orca-step-*'
const COPY_NAME = /^\.orca-step-[0-9a-f]{12}-/
// Older than any step could still be running: left by a crash, or a file Windows held at cut-off.
const STALE_COPY_MS = (MAX_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS + 300) * 1000

/**
 * Keeps Orca's copies out of `git status` and `git add -A` (a step that commits must not commit
 * one), once per repository. A folder workspace has no repository and nothing to exclude.
 */
async function excludeCopiesFromGit(dir: string, wslDistro: string | undefined): Promise<void> {
  let commonDir: string
  try {
    commonDir = await readableGitCommonDir(
      { cwd: dir, ...(wslDistro ? { wslDistro } : {}) },
      wslDistroForCommand(dir, wslDistro) ?? null
    )
  } catch {
    return
  }
  const exclude = windowsFsPath(join(commonDir, 'info', 'exclude'))
  if ((await lstat(exclude).catch(() => null))?.isSymbolicLink()) {
    console.warn('[automations] info/exclude is a symlink; script step copies stay unexcluded.')
    return
  }
  const current = await readFile(exclude, 'utf8').catch(() => '')
  if (current.split(/\r?\n/).includes(AUTOMATION_STEP_COPY_PATTERN)) {
    return
  }
  await mkdir(dirname(exclude), { recursive: true })
  const separator = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(
    exclude,
    `${separator}# Orca automation script step copies\n${AUTOMATION_STEP_COPY_PATTERN}\n`
  )
}

async function sweepStaleCopies(dir: string, now: number): Promise<void> {
  const names = await readdir(dir).catch((): string[] => [])
  for (const name of names.filter((entry) => COPY_NAME.test(entry))) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info && now - info.mtimeMs > STALE_COPY_MS) {
      await rm(path, { force: true }).catch(() => {})
    }
  }
}

/**
 * Runs a copy of the verified bytes beside the original, so a write between check and exec cannot
 * swap them while `$0` / `%~dp0` still name the script's own directory. Exclusive and randomly
 * named, so it never overwrites a file; the extension is kept for cmd.exe.
 */
async function withVerifiedCopy<T>(
  file: ScriptFile,
  wslDistro: string | undefined,
  run: (copy: string) => Promise<T>
): Promise<T | { copyError: string }> {
  const dir = dirname(file.path)
  await excludeCopiesFromGit(dir, wslDistro).catch((error: unknown) => {
    console.warn('[automations] could not exclude script step copies from Git:', error)
  })
  await sweepStaleCopies(dir, Date.now())
  const copy = join(dir, `.orca-step-${randomBytes(6).toString('hex')}-${basename(file.path)}`)
  let created = false
  try {
    await writeFile(copy, file.bytes, { flag: 'wx', mode: 0o700 })
    created = true
    await chmod(copy, file.mode)
  } catch (error) {
    if (created) {
      await rm(copy, { force: true }).catch(() => {})
    }
    return {
      copyError: `Orca could not write its verified copy beside the script (${errorMessage(error)}).`
    }
  }
  try {
    return await run(copy)
  } finally {
    await rm(copy, { force: true }).catch(() => {})
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
    const ran = await withVerifiedCopy(file, wsl?.distro ?? undefined, async (copy) => {
      const command = automationScriptStepCommand(
        wsl ? toLinuxPath(copy) : copy,
        step.args,
        getHookCommandShellKind(host.cwd, host.runtimeTarget),
        // Windows cannot set the exec bit on a WSL share, so the guest copies it from the original.
        wsl ? { modeFrom: toLinuxPath(file.path) } : {}
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
        // The copy is what runs, beside the original; this names the original file itself.
        pathEnv: {
          ...getSetupEnvVars(host.repo, host.cwd),
          ORCA_AUTOMATION_STEP_SCRIPT: file.path
        },
        env: { ...handoffEnv, ORCA_AUTOMATION_STEP_ID: step.id },
        runtimeTarget: host.runtimeTarget,
        timeoutMs: step.timeoutSeconds * 1000
      })
      if (!outcome.timedOut && isCopyModeFailure(outcome)) {
        return stepResult(step, timing, {
          outcome: 'unverifiable',
          contentHash,
          output: outcome.output,
          error: `${step.script}: the host could not make Orca's verified copy runnable.`
        })
      }
      return stepResult(step, timing, {
        // Timeout first: the exit code of something we stopped is not evidence it finished (#19334).
        outcome: outcome.timedOut ? 'cut_off' : outcome.success ? 'succeeded' : 'failed',
        contentHash,
        exitCode: outcome.timedOut ? null : outcome.success ? 0 : (outcome.exitCode ?? null),
        output: outcome.output,
        stdout: outcome.stdout ?? ''
      })
    })
    return 'copyError' in ran
      ? stepResult(step, timing, {
          outcome: 'unverifiable',
          contentHash,
          error: `${step.script}: ${ran.copyError}`
        })
      : ran
  }
}
