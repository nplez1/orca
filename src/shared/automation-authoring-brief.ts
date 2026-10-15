/**
 * The brief an authoring session starts from.
 *
 * Authoring an automation is a conversation, not a form: a plan has an order, a
 * failure policy, and a choice of what is code and what is judgement, and the
 * honest way to settle those is to ask. So Orca's job here is not to generate the
 * automation — it is to hand an agent the model, the policy, and the exact command
 * to create the result, and then get out of the way.
 *
 * The policy is the same one this feature exists for. An automation has one
 * executable slot per step, and a script step is an inline shell command run in
 * the workspace that completes the run on exit with no agent, no PTY and no model
 * in the loop — so more of the work should be that, and an agent step should be
 * something the agent has to justify.
 */

import {
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_SECONDS,
  AUTOMATION_SCRIPT_TIMEOUT_MAX_SECONDS,
  AUTOMATION_SCRIPT_TIMEOUT_MIN_SECONDS,
  MAX_AUTOMATION_STEPS,
  formatAutomationStepsSummary,
  resolveAutomationSteps,
  type AutomationStepSource
} from './automation-steps'

export type AutomationAuthoringBriefMode = 'create' | 'edit'

export type AutomationAuthoringBriefInput = {
  mode: AutomationAuthoringBriefMode
  /** What the user typed, verbatim. */
  description: string
  projectName: string | null
  workspaceLabel: string | null
  hostLabel: string | null
  /** Where the automation runs, as far as this computer knows. */
  hostKind: 'local' | 'remote'
  /** The shell a script step is handed to, which decides what its command may use. */
  platform: 'darwin' | 'linux' | 'win32' | 'unknown'
  timezone: string
  /** The plan being changed, for an edit. */
  existing?: (AutomationStepSource & { id: string; name: string; schedule: string }) | null
}

/** One sentence per rule, in the order the agent has to apply them. */
export const AUTOMATION_AUTHORING_RULES: readonly string[] = [
  'Interview before proposing. Ask what triggers it, which workspace it runs in, what exactly has to happen, and how anyone can tell there was nothing to do. Ask one round of questions, not ten.',
  'Prefer script steps. A script step is an inline shell command run in the workspace on the target host; its exit status is the run, and no agent is involved at all. Anything a command can do belongs here.',
  'Add an agent step only for work that needs judgement — summarising, deciding, editing, writing. There can be at most one, and it must be last, because it hands the run to a terminal.',
  'Most query commands exit 0 even when they find nothing, so a step that checks for work has to turn "nothing to do" into a non-zero exit itself. A gate that always passes is the same as no gate.',
  'Set onFailure to "continue" only when the following steps genuinely do not depend on this one. Otherwise "stop", which ends the run and keeps the exit code as the reason.',
  'Commands run unattended: never interactive, never one that can prompt for credentials, and only ever as destructive as the job requires.',
  'Never leave an automation with no steps, and never reorder a plan so a script step follows the agent step.'
]

function describeHost(input: AutomationAuthoringBriefInput): string {
  const kind = input.hostKind === 'local' ? 'this computer' : 'a paired host'
  const label = input.hostLabel ? `"${input.hostLabel}"` : '(no host selected)'
  return `${label} — ${kind}`
}

function describeShell(platform: AutomationAuthoringBriefInput['platform']): string {
  if (platform === 'win32') {
    return 'Script steps run under `cmd.exe`, so write Windows commands: no POSIX-only constructs, no `sh` syntax.'
  }
  if (platform === 'darwin' || platform === 'linux') {
    return `Script steps run under \`/bin/sh\` on ${platform}, so write POSIX commands.`
  }
  return "The target host's platform is not known from here, so keep every command to constructs that work in both a POSIX shell and `cmd.exe`, and keep it simple enough to be true either way."
}

/** The plan as JSON, for the edit brief: the agent has to know what it is changing. */
function describeExistingPlan(existing: AutomationAuthoringBriefInput['existing']): string[] {
  if (!existing) {
    return []
  }
  return [
    '',
    '## The automation being changed',
    '',
    `- id: ${existing.id}`,
    `- name: ${existing.name}`,
    `- schedule: ${existing.schedule}`,
    `- current plan: ${formatAutomationStepsSummary(existing)}`,
    '',
    '```json',
    JSON.stringify(resolveAutomationSteps(existing), null, 2),
    '```'
  ]
}

export function buildAutomationAuthoringBrief(input: AutomationAuthoringBriefInput): string {
  const isEdit = input.mode === 'edit'
  return [
    isEdit
      ? 'You are changing one existing Orca automation with the person who owns it. They will describe the change; you interview, propose, confirm, and then apply it.'
      : 'You are creating one Orca automation with the person who wants it. They will describe what they want automated; you interview, propose, confirm, and then create it.',
    '',
    '## What an Orca automation is',
    '',
    '- It runs on a schedule, in a workspace, on one host.',
    '- It is an ordered list of steps. A script step is an inline shell command run in the workspace on the target host: its exit status is the result, and no agent, terminal or model is involved. An agent step starts a terminal agent with a prompt and hands the run to it.',
    '- `precheck` is a separate, optional gate that runs before the whole plan on scheduled runs: exit 0 runs the plan, anything else records the run as skipped. Use it for "is there any work at all", not for work.',
    '',
    '## How to do this job',
    '',
    ...AUTOMATION_AUTHORING_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    '## What you already know',
    '',
    `- Project: ${input.projectName ?? '(none selected)'}`,
    `- Workspace: ${input.workspaceLabel ?? '(none selected)'}`,
    `- Target host: ${describeHost(input)}`,
    `- Timezone the schedule is read in: ${input.timezone}`,
    `- ${describeShell(input.platform)}`,
    `- Step limits: at most ${MAX_AUTOMATION_STEPS} steps; a script timeout is ${
      AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_SECONDS
    }s by default and may be between ${AUTOMATION_SCRIPT_TIMEOUT_MIN_SECONDS}s and ${
      AUTOMATION_SCRIPT_TIMEOUT_MAX_SECONDS
    }s.`,
    '',
    '## What they asked for',
    '',
    input.description.trim(),
    ...describeExistingPlan(input.existing),
    '',
    '## How to apply it',
    '',
    isEdit
      ? `When they confirm, apply the change with the Orca CLI (a plan replaces the whole step list):`
      : `When they confirm, create it with the Orca CLI:`,
    '',
    '```sh',
    isEdit
      ? `orca automations edit <id> --steps-json '[{"kind":"script","command":"…","timeoutSeconds":900,"onFailure":"stop"}]' --json`
      : `orca automations create --name "<name>" --trigger "<cron or preset>" --workspace <selector> --steps-json '[{"kind":"script","command":"…","timeoutSeconds":900,"onFailure":"stop"}]' --json`,
    '```',
    '',
    `Step shapes: \`{"kind":"script","command":"…","timeoutSeconds":900,"onFailure":"stop"|"continue"}\` and \`{"kind":"agent","prompt":"…","agentId":"claude"}\`.`,
    'A schedule is a preset (hourly, daily, weekdays, weekly), a 5-field cron expression, or an RRULE. Run `orca automations create --help` if you need the other flags.',
    'The CLI is on your PATH as `orca`. If `$ORCA_CLI_COMMAND` is set, use exactly that launcher instead — it names the binary this Orca installed.',
    '',
    isEdit
      ? 'Do not create a second automation: change the one above, and tell them what you changed.'
      : 'Do not fill in any form: the CLI call is how this automation comes into existence. Tell them the name and schedule you used so they can find it in the Automations panel.'
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/**
 * The opening line of an edit session. Prompt text lives here, not in the renderer:
 * it is written for the agent, not shown as UI copy, so it is not translated.
 */
export function automationEditBriefOpening(name: string): string {
  return `They want to change the automation "${name}". Ask what should change before proposing anything.`
}

/** A short tab title, so the session is recognisable next to other terminals. */
export function automationAuthoringSessionTitle(input: {
  mode: AutomationAuthoringBriefMode
  name: string | null
}): string {
  const name = input.name?.trim()
  if (input.mode === 'edit') {
    return name ? `Automation: ${name}` : 'Edit automation'
  }
  return 'New automation'
}
