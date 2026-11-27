import type { AutomationAction, AutomationScript } from '../automation-definition'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

export const DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS = 600
export const MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS = 3600
/** A command is a shell line, not a script file; the launcher caps it the way a precheck is capped. */
export const MAX_AUTOMATION_COMMAND_LENGTH = 4000

export function normalizeAutomationCommandTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS
  }
  return Math.min(MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS, Math.max(1, Math.floor(value)))
}

/** Null when there is nothing to run, which reads as an agent automation and never half a command. */
export function normalizeAutomationScript(
  script: AutomationScript | null | undefined
): AutomationScript | null {
  const command = typeof script?.command === 'string' ? script.command.trim() : ''
  if (!command || command.length > MAX_AUTOMATION_COMMAND_LENGTH) {
    return null
  }
  return {
    command,
    timeoutSeconds: normalizeAutomationCommandTimeoutSeconds(script?.timeoutSeconds),
    shell: script?.shell === 'plain' ? 'plain' : 'login',
    report: normalizeAutomationReport(script?.report)
  }
}

function normalizeAutomationReport(report: unknown): AutomationScript['report'] {
  return report === 'silent' || report === 'always' ? report : 'on-output'
}

export function normalizeAutomationAction(
  action: AutomationAction | null | undefined
): AutomationAction | undefined {
  if (action?.kind !== 'command') {
    return undefined
  }
  const script = normalizeAutomationScript(action.script)
  return script ? { kind: 'command', script } : undefined
}

/** A command automation launches no agent; every other automation does. */
export function isCommandAutomation(automation: { action?: AutomationAction }): boolean {
  return automation.action?.kind === 'command'
}

/** The command a run needs: an agent automation never reaches the command runner. */
export function requireAutomationScript(automation: {
  action?: AutomationAction
}): AutomationScript {
  if (automation.action?.kind !== 'command') {
    throw new Error('This automation launches an agent, so it has no command to run.')
  }
  return automation.action.script
}

/**
 * The agent a launch needs. A command automation never reaches a launcher, so this fails loudly rather
 * than launching an agent for a run that asked for a command.
 */
export function requireAutomationAgent(automation: { agentId: TuiAgent | null }): TuiAgent {
  if (!automation.agentId) {
    throw new Error('This automation runs a command, so it has no agent to launch.')
  }
  return automation.agentId
}
