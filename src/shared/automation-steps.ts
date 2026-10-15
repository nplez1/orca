/**
 * What an automation actually does, as an ordered plan of steps.
 *
 * An automation used to be one prose prompt to one agent, which meant a
 * deterministic job — pull, set up, build — paid an agent to re-derive a
 * procedure the user already knew. A plan fixes that by making the executable
 * part first-class: a `script` step is an inline shell command run on the
 * execution host, in the workspace, that completes the run on process exit with
 * no agent, no PTY and no model in the loop. An `agent` step is the old
 * behaviour, and it is now what it should always have been: the step you add when
 * judgement is genuinely required.
 *
 * v1 keeps the shape narrow on purpose. Steps run in order, script steps come
 * first, there is at most one agent step and it is last — because an agent step
 * hands the run to a terminal whose completion is observed asynchronously, so
 * anything after it would need a resumed plan that does not exist yet.
 */

import type { TuiAgent } from './tui-agent'

export const AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_SECONDS = 900
export const AUTOMATION_SCRIPT_TIMEOUT_MIN_SECONDS = 5
export const AUTOMATION_SCRIPT_TIMEOUT_MAX_SECONDS = 3600
export const MAX_AUTOMATION_STEPS = 16
export const AUTOMATION_STEP_LABEL_MAX_CHARS = 200
/** How much of one step's output a stored run keeps, per stream. */
export const MAX_AUTOMATION_STEP_STORED_OUTPUT_CHARS = 16 * 1024
export const AUTOMATION_STEP_STATUSES: readonly AutomationStepStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'skipped'
]

export type AutomationStepOnFailure = 'stop' | 'continue'
export type AutomationStepKind = 'script' | 'agent'

export type AutomationScriptStep = {
  kind: 'script'
  /** Inline shell command, run on the execution host with the workspace as cwd. */
  command: string
  timeoutSeconds: number
  /** `stop` ends the run when this step fails; `continue` runs the rest of the plan. */
  onFailure: AutomationStepOnFailure
}

export type AutomationAgentStep = {
  kind: 'agent'
  prompt: string
  agentId: TuiAgent
}

export type AutomationStep = AutomationScriptStep | AutomationAgentStep

export type AutomationStepStatus = 'succeeded' | 'failed' | 'timed_out' | 'skipped'

/**
 * What one script step did.
 *
 * Only script steps carry a result: an agent step's outcome *is* the run's, so
 * recording it twice would invite the two records to disagree. `index` keeps the
 * result tied to its place in the plan.
 */
export type AutomationStepResult = {
  index: number
  kind: 'script'
  /** The command's first line, so a result is readable without the plan beside it. */
  label: string
  status: AutomationStepStatus
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type AutomationStepsParseResult =
  | { ok: true; steps: AutomationStep[] }
  | { ok: false; error: string }

/** Anything that can carry a plan: the record, or a legacy input with no steps. */
export type AutomationStepSource = {
  steps?: readonly AutomationStep[] | null
  prompt?: string | null
  agentId?: TuiAgent | null
}

export function isAutomationScriptStep(step: AutomationStep): step is AutomationScriptStep {
  return step.kind === 'script'
}

export function isAutomationAgentStep(step: AutomationStep): step is AutomationAgentStep {
  return step.kind === 'agent'
}

export function normalizeAutomationScriptTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_SECONDS
  }
  return Math.min(
    AUTOMATION_SCRIPT_TIMEOUT_MAX_SECONDS,
    Math.max(AUTOMATION_SCRIPT_TIMEOUT_MIN_SECONDS, Math.floor(value))
  )
}

function normalizeOnFailure(value: unknown): AutomationStepOnFailure {
  return value === 'continue' ? 'continue' : 'stop'
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an unknown for field-by-field validation; every field read below is checked before use.
      (value as Record<string, unknown>)
    : null
}

/** The command's first line, which is what a run row and a log line can show. */
export function automationStepLabel(step: AutomationStep): string {
  if (isAutomationAgentStep(step)) {
    return step.prompt.trim().split('\n')[0] ?? ''
  }
  return step.command.trim().split('\n')[0] ?? ''
}

/**
 * Whether a plan may be executed, in the vocabulary the wire and the store share.
 *
 * An empty plan is refused rather than defaulted: an automation with nothing to
 * do would run its schedule forever and report success for having done so.
 */
export function validateAutomationSteps(
  steps: readonly AutomationStep[] | null | undefined
): { ok: true; steps: AutomationStep[] } | { ok: false; error: string } {
  const raw = steps ?? []
  if (raw.length === 0) {
    return { ok: false, error: 'An automation needs at least one step.' }
  }
  if (raw.length > MAX_AUTOMATION_STEPS) {
    return {
      ok: false,
      error: `An automation can have at most ${MAX_AUTOMATION_STEPS} steps.`
    }
  }
  // Shape before content: "two agent steps" and "the agent step is not last" are the
  // diagnoses a user can act on, and running the per-step checks first would report
  // whichever of them happened to be at index 0 as something else.
  const agentIndexes = raw
    .map((step, index) => (step.kind === 'agent' ? index : -1))
    .filter((index) => index >= 0)
  if (agentIndexes.length > 1) {
    return { ok: false, error: 'An automation can have only one agent step.' }
  }
  if (agentIndexes.length === 1 && agentIndexes[0] !== raw.length - 1) {
    return {
      ok: false,
      error:
        'The agent step has to be the last step, because it ends the run by handing it to a terminal.'
    }
  }
  const validated: AutomationStep[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const step = raw[index]!
    if (step.kind === 'script') {
      const command = step.command.trim()
      if (!command) {
        return { ok: false, error: `Step ${index + 1} has no command.` }
      }
      validated.push({
        kind: 'script',
        command,
        timeoutSeconds: normalizeAutomationScriptTimeoutSeconds(step.timeoutSeconds),
        onFailure: normalizeOnFailure(step.onFailure)
      })
      continue
    }
    if (step.kind === 'agent') {
      const prompt = step.prompt.trim()
      if (!prompt) {
        return { ok: false, error: 'The agent step has no prompt.' }
      }
      validated.push({ kind: 'agent', prompt, agentId: step.agentId })
      continue
    }
    return { ok: false, error: `Step ${index + 1} has an unknown kind.` }
  }
  return { ok: true, steps: validated }
}

/** The same validation, for a plan that arrived as JSON (the CLI's `--steps-json`). */
export function parseAutomationSteps(value: unknown): AutomationStepsParseResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Steps must be a JSON array of step objects.' }
  }
  const steps: AutomationStep[] = []
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry)
    if (!record) {
      return { ok: false, error: `Step ${index + 1} is not an object.` }
    }
    if (record.kind === 'script') {
      steps.push({
        kind: 'script',
        command: asTrimmedString(record.command),
        timeoutSeconds: normalizeAutomationScriptTimeoutSeconds(record.timeoutSeconds),
        onFailure: normalizeOnFailure(record.onFailure)
      })
      continue
    }
    if (record.kind === 'agent') {
      const agentId = asTrimmedString(record.agentId)
      if (!agentId) {
        return { ok: false, error: `Step ${index + 1} is an agent step with no agentId.` }
      }
      steps.push({
        kind: 'agent',
        prompt: asTrimmedString(record.prompt),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the value is validated by the plan validator below, which is the only reader of this field's semantics.
        agentId: agentId as TuiAgent
      })
      continue
    }
    return { ok: false, error: `Step ${index + 1} must have kind "script" or "agent".` }
  }
  return validateAutomationSteps(steps)
}

/**
 * The plan to execute, wherever it came from.
 *
 * Records written before steps existed carry the single agent step flat on the
 * record, and are read back as exactly that one-step plan — the same shape the
 * older writers meant. Nothing is written at read time: a legacy record keeps its
 * fields until something updates it.
 */
export function resolveAutomationSteps(source: AutomationStepSource): AutomationStep[] {
  const planned = validateAutomationSteps(source.steps)
  if (planned.ok) {
    return planned.steps
  }
  if (source.steps && source.steps.length > 0) {
    // A stored plan this build will not validate is still what the record says it does;
    // the run path refuses it with a message, but a reader must not report it as empty.
    return [...source.steps]
  }
  // A record written before steps existed, with no prompt at all, is still one agent
  // step: the old launch ran a blank prompt as a bare agent, and that is what it meant.
  if (source.agentId) {
    return [{ kind: 'agent', prompt: source.prompt?.trim() ?? '', agentId: source.agentId }]
  }
  return []
}

/** The agent step, when the plan has one. Everything agent-related reads this. */
export function resolveAutomationAgentStep(
  source: AutomationStepSource
): AutomationAgentStep | null {
  const steps = resolveAutomationSteps(source)
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!
    if (isAutomationAgentStep(step)) {
      return step
    }
  }
  return null
}

export function automationStepsHaveAgent(source: AutomationStepSource): boolean {
  return resolveAutomationAgentStep(source) !== null
}

export function automationScriptSteps(source: AutomationStepSource): AutomationScriptStep[] {
  return resolveAutomationSteps(source).filter(isAutomationScriptStep)
}

/**
 * What the record's flat `prompt`/`agentId` should say, for the readers that
 * predate steps.
 *
 * The two fields are kept populated from the agent step and cleared when the plan
 * has none, so an older reader sees "this automation has no agent prompt" rather
 * than a prompt belonging to a step that no longer runs.
 */
export function automationLegacyAgentFields(source: AutomationStepSource): {
  prompt: string
  agentId: TuiAgent | null
} {
  const agentStep = resolveAutomationAgentStep(source)
  return { prompt: agentStep?.prompt ?? '', agentId: agentStep?.agentId ?? null }
}

export type AutomationStepPatch = {
  steps?: readonly AutomationStep[] | null
  prompt?: string | null
  agentId?: TuiAgent | null
}

/**
 * The plan a write should store, given what it patches.
 *
 * `steps: null` means "leave the stored plan alone", which is what an unrelated
 * patch (enabling, renaming, rescheduling) must get: validating an untouched plan
 * on every write would let an old record's shape block a rename.
 *
 * A patch that carries only the flat `prompt`/`agentId` — an older client, or the
 * editor's own form — edits the agent step *inside* the stored plan rather than
 * replacing the plan, so a script+agent automation survives being renamed by a
 * reader that has never heard of steps. When the plan has no agent step, such a
 * patch adds one, last, because that is the only place it can legally go.
 */
export function applyAutomationStepPatch(input: {
  current: AutomationStepSource
  patch: AutomationStepPatch
}): { ok: true; steps: AutomationStep[] | null } | { ok: false; error: string } {
  const { current, patch } = input
  if (patch.steps !== undefined) {
    const planned = validateAutomationSteps(patch.steps)
    return planned.ok ? { ok: true, steps: planned.steps } : planned
  }
  if (patch.prompt === undefined && patch.agentId === undefined) {
    return { ok: true, steps: null }
  }
  const existing = resolveAutomationSteps(current)
  const agentIndex = existing.findIndex(isAutomationAgentStep)
  if (agentIndex === -1) {
    const prompt = patch.prompt?.trim() ?? ''
    const agentId = patch.agentId ?? null
    if (!prompt || !agentId) {
      return {
        ok: false,
        error: 'An agent step needs both a prompt and an agent.'
      }
    }
    return validateAutomationSteps([...existing, { kind: 'agent', prompt, agentId }])
  }
  const agentStep = existing[agentIndex]!
  if (!isAutomationAgentStep(agentStep)) {
    return { ok: false, error: 'The stored plan is not readable.' }
  }
  const prompt = patch.prompt != null ? patch.prompt.trim() : agentStep.prompt
  const agentId = patch.agentId ?? agentStep.agentId
  if (!prompt) {
    return { ok: false, error: 'An agent step needs a prompt.' }
  }
  const next = [...existing]
  next[agentIndex] = { kind: 'agent', prompt, agentId }
  return validateAutomationSteps(next)
}

/** One line for a list row, a CLI line, or a dialog's summary. */
export function formatAutomationStepsSummary(source: AutomationStepSource): string {
  const steps = resolveAutomationSteps(source)
  const scripts = steps.filter(isAutomationScriptStep).length
  const agents = steps.length - scripts
  if (agents === 0) {
    return scripts === 1 ? '1 script step' : `${scripts} script steps`
  }
  if (scripts === 0) {
    return agents === 1 ? '1 agent step' : `${agents} agent steps`
  }
  return scripts === 1 ? '1 script step, then an agent' : `${scripts} script steps, then an agent`
}
