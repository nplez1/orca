// A precheck: the gate an automation runs before it launches, through the shared command runner.
import type { ChildProcess } from 'node:child_process'
import type { AutomationPrecheck } from '../../../shared/automations/automation-definition'
import type { AutomationPrecheckResult } from '../../../shared/automations/history/automation-run'
import {
  failedCommandResult,
  killLocalCommandProcessTree,
  runHostCommand,
  type HostCommandRun,
  type HostCommandTarget
} from './command-runner'

/** Every precheck runs plainly, and names itself in a timeout message. */
const PRECHECK_RUN = {
  shell: 'plain',
  label: 'Precheck',
  killSite: 'automation-precheck-timeout'
} as const satisfies Omit<HostCommandRun, 'command'>

export function failedPrecheckResult(
  precheck: AutomationPrecheck,
  startedAt: number,
  error: string
): AutomationPrecheckResult {
  return failedCommandResult({ ...PRECHECK_RUN, command: precheck }, startedAt, error)
}

export function killLocalPrecheckProcessTree(
  child: ChildProcess
): ReturnType<typeof setTimeout> | null {
  return killLocalCommandProcessTree(child, PRECHECK_RUN.killSite)
}

export async function runAutomationPrecheck(args: {
  precheck: AutomationPrecheck
  target: HostCommandTarget
}): Promise<AutomationPrecheckResult> {
  return await runHostCommand({ ...PRECHECK_RUN, command: args.precheck }, args.target)
}
