import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isCmdUnsafe } from './automation-script-step-command'

export type AutomationScriptStepFailurePolicy = 'stop' | 'continue'

/** Runs a committed file from the project checkout on the automation's host; never a shell body. */
export type AutomationScriptStep = {
  kind: 'script'
  /** Names the step's handoff variables (`ORCA_STEP_<ID>_*`); unique within the automation. */
  id: string
  /** Path relative to the project root, e.g. `scripts/triage.sh`. */
  script: string
  args?: string[]
  timeoutSeconds: number
  onFailure: AutomationScriptStepFailurePolicy
  /**
   * Host-written only, by the desktop approval IPC: a digest over path, args and file bytes.
   * Every client write is stripped of it, and a run whose pin differs is refused as unapproved.
   */
  approvedPin?: string
}

/**
 * Where the automation's agent runs. Its prompt lives here because the record's own `prompt`
 * holds the stand-down text an older host would hand its agent; agent and arguments stay on the record.
 */
export type AutomationAgentStepMarker = { kind: 'agent'; id: string; prompt?: string }

export type AutomationStepRecord = AutomationScriptStep | AutomationAgentStepMarker

export type AutomationAgentStep = {
  kind: 'agent'
  id: string
  prompt: string
  agentId: TuiAgent
  extraAgentArgs?: string
}

export type AutomationStep = AutomationScriptStep | AutomationAgentStep

export const AUTOMATION_AGENT_STEP_ID = 'agent'
export const MAX_AUTOMATION_SCRIPT_STEPS = 8
export const MAX_AUTOMATION_SCRIPT_STEP_ARGS = 32
export const MAX_AUTOMATION_SCRIPT_STEP_ARG_CHARS = 1024
export const MAX_AUTOMATION_SCRIPT_PATH_CHARS = 512
export const DEFAULT_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS = 120
export const MAX_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS = 3600
/** Bounded so the handoff fits one environment variable on every platform (Windows caps at 32767). */
export const MAX_AUTOMATION_STEP_HANDOFF_CHARS = 16_000
/** The record's `prompt` whenever it has steps: an older Orca ignores steps and sends its agent this. */
export const AUTOMATION_STEPS_STAND_DOWN_PROMPT =
  'This automation runs script steps, which this version of Orca cannot run. Do nothing else: reply that the run was skipped and that Orca must be updated to run it.'

const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
// Why: a portable path charset needs no quoting in bash or cmd.exe and cannot carry a shell body.
const SCRIPT_PATH_PATTERN = /^[A-Za-z0-9._@+=,/-]+$/
/** Format, line/paragraph separators and C1 controls can make an argument read differently from what runs. */
const INVISIBLE_CHAR = /[\p{Cf}\p{Zl}\p{Zp}]/u

function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x80 && code <= 0x9f) || INVISIBLE_CHAR.test(char)
}

function isPassableArg(arg: unknown): arg is string {
  return (
    typeof arg === 'string' &&
    arg.length <= MAX_AUTOMATION_SCRIPT_STEP_ARG_CHARS &&
    ![...arg].some((char) => isCmdUnsafe(char) || isInvisible(char))
  )
}

export type AutomationStepsErrorCode =
  | 'steps_invalid'
  | 'steps_empty'
  | 'steps_too_many'
  | 'step_id_invalid'
  | 'step_id_duplicate'
  | 'agent_step_not_last'
  | 'script_step_shell_body'
  | 'script_step_path_invalid'
  | 'script_step_args_invalid'
  | 'script_step_timeout_invalid'

export class AutomationStepsError extends Error {
  constructor(
    readonly code: AutomationStepsErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AutomationStepsError'
  }
}

export type AutomationStepsValidation =
  | { ok: true; steps: AutomationStepRecord[] }
  | { ok: false; code: AutomationStepsErrorCode; error: string }

function refuse(code: AutomationStepsErrorCode, error: string): AutomationStepsValidation {
  return { ok: false, code, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateScriptPath(script: unknown): AutomationStepsValidation | string {
  if (typeof script !== 'string' || !script.trim()) {
    return refuse('script_step_path_invalid', 'A script step needs the path of a committed file.')
  }
  if (/[\r\n]/.test(script) || /\s/.test(script.trim())) {
    return refuse(
      'script_step_shell_body',
      'A script step names a committed file, not a shell command. Move the commands into a file in the repository and name that file.'
    )
  }
  const path = script.trim()
  const segments = path.split('/')
  if (
    path.length > MAX_AUTOMATION_SCRIPT_PATH_CHARS ||
    !SCRIPT_PATH_PATTERN.test(path) ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    path.endsWith('/') ||
    segments.some((segment) => segment === '' || segment === '..')
  ) {
    return refuse(
      'script_step_path_invalid',
      `"${path}" is not a path inside the project. Use a relative path such as scripts/triage.sh, with letters, digits and . _ - / only.`
    )
  }
  return path.replace(/^(\.\/)+/, '')
}

function validateScriptStep(value: Record<string, unknown>, id: string, keepApproval: boolean) {
  const script = validateScriptPath(value.script)
  if (typeof script !== 'string') {
    return script
  }
  const args: unknown = value.args === undefined ? [] : value.args
  if (
    !Array.isArray(args) ||
    args.length > MAX_AUTOMATION_SCRIPT_STEP_ARGS ||
    !args.every(isPassableArg)
  ) {
    return refuse(
      'script_step_args_invalid',
      `Script step "${id}" has an argument Orca cannot pass safely on every platform (quotes, %, !, control or invisible characters).`
    )
  }
  const timeout = value.timeoutSeconds ?? DEFAULT_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS
  ) {
    return refuse(
      'script_step_timeout_invalid',
      `Script step "${id}" needs a timeout between 1 and ${MAX_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS} seconds.`
    )
  }
  const step: AutomationScriptStep = {
    kind: 'script',
    id,
    script,
    ...(args.length > 0 ? { args: [...args] } : {}),
    timeoutSeconds: timeout,
    onFailure: value.onFailure === 'continue' ? 'continue' : 'stop',
    ...(keepApproval && typeof value.approvedPin === 'string' && value.approvedPin
      ? { approvedPin: value.approvedPin }
      : {})
  }
  return step
}

/**
 * v1 shape: script steps, then at most one agent step, which must be last. Refuses rather than
 * repairs, so a write never silently drops a step that was meant to gate the agent.
 */
export function validateAutomationSteps(
  value: unknown,
  /** Only for records this host stored; anything a client sent must never carry an approval. */
  options: { keepApprovals?: boolean } = {}
): AutomationStepsValidation {
  if (!Array.isArray(value)) {
    return refuse('steps_invalid', 'Automation steps must be a list.')
  }
  if (value.length === 0) {
    return refuse('steps_empty', 'An automation needs at least one step.')
  }
  const steps: AutomationStepRecord[] = []
  const ids = new Set<string>()
  let scriptSteps = 0
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || (entry.kind !== 'script' && entry.kind !== 'agent')) {
      return refuse('steps_invalid', 'Each step must be a script step or an agent step.')
    }
    const id =
      typeof entry.id === 'string'
        ? entry.id
        : entry.kind === 'agent'
          ? AUTOMATION_AGENT_STEP_ID
          : ''
    if (!STEP_ID_PATTERN.test(id)) {
      return refuse(
        'step_id_invalid',
        `Step id "${id}" must start with a letter and use only a-z, 0-9 and _ (at most 32).`
      )
    }
    if (ids.has(id)) {
      return refuse('step_id_duplicate', `Two steps share the id "${id}".`)
    }
    ids.add(id)
    if (entry.kind === 'agent') {
      if (index !== value.length - 1) {
        return refuse('agent_step_not_last', 'The agent step must be the last step.')
      }
      steps.push({
        kind: 'agent',
        id,
        ...(typeof entry.prompt === 'string' ? { prompt: entry.prompt } : {})
      })
      continue
    }
    scriptSteps += 1
    if (scriptSteps > MAX_AUTOMATION_SCRIPT_STEPS) {
      return refuse(
        'steps_too_many',
        `An automation can have at most ${MAX_AUTOMATION_SCRIPT_STEPS} script steps.`
      )
    }
    const step = validateScriptStep(entry, id, options.keepApprovals === true)
    if ('ok' in step) {
      return step
    }
    steps.push(step)
  }
  return { ok: true, steps }
}

/** Write-time form: a typed error the caller surfaces, never a partially saved list, never a pin. */
export function parseAutomationStepsForWrite(value: unknown): AutomationStepRecord[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const parsed = validateAutomationSteps(value)
  if (!parsed.ok) {
    throw new AutomationStepsError(parsed.code, parsed.error)
  }
  // A lone agent step is the legacy shape; storing nothing keeps the record byte-identical.
  return parsed.steps.some((step) => step.kind === 'script') ? parsed.steps : undefined
}

type AutomationStepSource = {
  steps?: unknown
  prompt: string
  agentId: TuiAgent
  extraAgentArgs?: string
}

/**
 * The automation's steps. A record without `steps` is the one-step agent case, so legacy
 * records need no rewrite: the migration is this read.
 */
export function resolveAutomationSteps(
  automation: AutomationStepSource
): AutomationStepsValidation & {
  resolved?: AutomationStep[]
} {
  const agentStep = (id: string): AutomationAgentStep => ({
    kind: 'agent',
    id,
    prompt: getAutomationAgentPrompt(automation),
    agentId: automation.agentId,
    ...(automation.extraAgentArgs ? { extraAgentArgs: automation.extraAgentArgs } : {})
  })
  if (automation.steps === undefined) {
    return {
      ok: true,
      steps: [{ kind: 'agent', id: AUTOMATION_AGENT_STEP_ID }],
      resolved: [agentStep(AUTOMATION_AGENT_STEP_ID)]
    }
  }
  const parsed = validateAutomationSteps(automation.steps, { keepApprovals: true })
  if (!parsed.ok) {
    return parsed
  }
  return {
    ...parsed,
    resolved: parsed.steps.map((step) => (step.kind === 'agent' ? agentStep(step.id) : step))
  }
}

/** The prompt the agent step runs: the agent step's own, or the record's on a legacy record. */
export function getAutomationAgentPrompt(automation: { steps?: unknown; prompt: string }): string {
  if (!Array.isArray(automation.steps)) {
    return automation.prompt
  }
  const marker: unknown = automation.steps.find((step) => isRecord(step) && step.kind === 'agent')
  return isRecord(marker) && typeof marker.prompt === 'string' ? marker.prompt : ''
}

export function getAutomationScriptSteps(automation: { steps?: unknown }): AutomationScriptStep[] {
  if (!Array.isArray(automation.steps)) {
    return []
  }
  return automation.steps.filter(
    (step): step is AutomationScriptStep => isRecord(step) && step.kind === 'script'
  )
}

export function automationHasScriptSteps(automation: { steps?: unknown }): boolean {
  return getAutomationScriptSteps(automation).length > 0
}

/** False only for a script-only automation; a legacy record always runs its agent. */
export function automationRunsAgentStep(automation: { steps?: unknown }): boolean {
  if (!Array.isArray(automation.steps)) {
    return true
  }
  return automation.steps.some((step) => isRecord(step) && step.kind === 'agent')
}
