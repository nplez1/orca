import { MAX_AUTOMATION_STEP_HANDOFF_CHARS, type AutomationScriptStep } from './automation-steps'

/**
 * `failed` has a real exit code; `cut_off` hit its timeout, whatever the process reported after
 * the signal (#19334); `unverifiable` means the host could not run it; `unapproved` means its
 * content was never approved, or changed since.
 */
export type AutomationStepOutcome =
  | 'succeeded'
  | 'failed'
  | 'cut_off'
  | 'unverifiable'
  | 'unapproved'

export type AutomationStepResult = {
  stepId: string
  kind: 'script'
  script: string
  args?: string[]
  /** Hash of the file content that ran or was refused; null when it could not be read. */
  contentHash: string | null
  outcome: AutomationStepOutcome
  exitCode: number | null
  /** Tail of stdout then stderr, bounded by MAX_AUTOMATION_STEP_HANDOFF_CHARS. */
  output: string
  outputTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
  durationMs: number
  /** The refused file's content, for the approval prompt; only on `unapproved`. */
  reviewContent?: string
  /** The step's own stdout for the handoff; never persisted. */
  stdout?: string
}

export const MAX_AUTOMATION_STEP_REVIEW_CONTENT_CHARS = 64 * 1024
/** The run record keeps a shorter tail than the handoff, like a precheck's. */
export const MAX_PERSISTED_AUTOMATION_STEP_OUTPUT_CHARS = 4000

export type AutomationScriptStepExecutor = (
  step: AutomationScriptStep,
  handoffEnv: Readonly<Record<string, string>>
) => Promise<AutomationStepResult>

export type AutomationScriptStepsOutcome = {
  results: AutomationStepResult[]
  /** The step that ended the run; null when every step succeeded or was allowed to fail. */
  stoppedBy: AutomationStepResult | null
  /** Handoff variables for the next step and the agent. */
  env: Record<string, string>
}

/** Consent and host refusals stop the run even under `continue`: neither is the script failing. */
function stopsRun(step: AutomationScriptStep, result: AutomationStepResult): boolean {
  if (result.outcome === 'succeeded') {
    return false
  }
  if (result.outcome === 'unapproved' || result.outcome === 'unverifiable') {
    return true
  }
  return step.onFailure !== 'continue'
}

export async function runAutomationScriptSteps(
  steps: readonly AutomationScriptStep[],
  execute: AutomationScriptStepExecutor
): Promise<AutomationScriptStepsOutcome> {
  const results: AutomationStepResult[] = []
  let env: Record<string, string> = {}
  for (const step of steps) {
    const result = await execute(step, env)
    results.push(result)
    env = { ...env, ...automationStepHandoffEnv(result) }
    if (stopsRun(step, result)) {
      return { results, stoppedBy: result, env }
    }
  }
  return { results, stoppedBy: null, env }
}

export function automationStepEnvPrefix(stepId: string): string {
  return `ORCA_STEP_${stepId.toUpperCase()}`
}

export function automationStepHandoffEnv(result: AutomationStepResult): Record<string, string> {
  const prefix = automationStepEnvPrefix(result.stepId)
  return {
    [`${prefix}_OUTCOME`]: result.outcome,
    [`${prefix}_EXIT`]: result.exitCode === null ? '' : String(result.exitCode),
    // A NUL cannot travel in an environment block; it would end the value early.
    [`${prefix}_STDOUT`]: (result.stdout ?? '').replaceAll('\0', '')
  }
}

export function boundAutomationStepOutput(output: string): { output: string; truncated: boolean } {
  return output.length > MAX_AUTOMATION_STEP_HANDOFF_CHARS
    ? { output: output.slice(-MAX_AUTOMATION_STEP_HANDOFF_CHARS), truncated: true }
    : { output, truncated: false }
}

export function formatAutomationStepFailure(result: AutomationStepResult): string {
  const name = `Script step "${result.stepId}" (${result.script})`
  switch (result.outcome) {
    case 'cut_off':
      return `${name} was stopped at its ${Math.max(1, Math.round(result.durationMs / 1000))}s timeout.`
    case 'failed':
      return result.exitCode === null
        ? `${name} was terminated without reporting an exit code.`
        : `${name} exited with code ${result.exitCode}.`
    case 'unapproved':
      return `${name} needs approval: its content is new or changed since it was approved. Open this run to review it.`
    case 'unverifiable':
      return `${name} could not run on this host: ${result.error ?? 'unknown error'}`
    case 'succeeded':
      return `${name} succeeded.`
  }
}

const OUTCOMES = new Set<AutomationStepOutcome>([
  'succeeded',
  'failed',
  'cut_off',
  'unverifiable',
  'unapproved'
])

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Load/write normalization; drops entries it cannot read rather than inventing an outcome. */
export function normalizeAutomationStepResults(value: unknown): AutomationStepResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const results: AutomationStepResult[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.stepId !== 'string' ||
      typeof entry.script !== 'string' ||
      !OUTCOMES.has(entry.outcome)
    ) {
      continue
    }
    const output = typeof entry.output === 'string' ? entry.output : ''
    const startedAt = finiteOr(entry.startedAt, 0)
    const completedAt = finiteOr(entry.completedAt, startedAt)
    results.push({
      stepId: entry.stepId,
      kind: 'script',
      script: entry.script,
      ...(Array.isArray(entry.args) && entry.args.every((arg: unknown) => typeof arg === 'string')
        ? { args: [...entry.args] }
        : {}),
      contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
      outcome: entry.outcome,
      exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : null,
      output: output.slice(-MAX_PERSISTED_AUTOMATION_STEP_OUTPUT_CHARS),
      outputTruncated:
        entry.outputTruncated === true ||
        output.length > MAX_PERSISTED_AUTOMATION_STEP_OUTPUT_CHARS,
      error: typeof entry.error === 'string' ? entry.error : null,
      startedAt,
      completedAt,
      durationMs: Math.max(0, finiteOr(entry.durationMs, completedAt - startedAt)),
      ...(entry.outcome === 'unapproved' && typeof entry.reviewContent === 'string'
        ? { reviewContent: entry.reviewContent.slice(0, MAX_AUTOMATION_STEP_REVIEW_CONTENT_CHARS) }
        : {})
    })
  }
  return results.length > 0 ? results : undefined
}
