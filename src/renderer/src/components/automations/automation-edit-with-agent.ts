/**
 * "Change it with an agent": editing a plan the same way it was authored.
 *
 * The panel can pause, reschedule and re-target an automation, but a plan is not
 * editable in a form — for the same reason it is not authored in one. So changing
 * one opens the same kind of session the create flow does, with the current plan in
 * the brief and the instruction to apply the change with the CLI.
 */

import {
  automationEditBriefOpening,
  buildAutomationAuthoringBrief
} from '../../../../shared/automation-authoring-brief'
import { resolveAutomationAgentStep } from '../../../../shared/automation-steps'
import { formatAutomationSchedule } from '../../../../shared/automation-schedules'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { launchAutomationAuthoringSession } from '@/lib/launch-automation-authoring-session'

export type StartAutomationEditWithAgentInput = {
  automation: Automation
  repo: Repo | null
  /** The workspace the session should open in: the automation's own, or the project's. */
  workspace: Worktree | null
  fallbackAgentId: TuiAgent
  hostLabel: string | null
  hostKind: 'local' | 'remote'
  platform: 'darwin' | 'linux' | 'win32' | 'unknown'
  timezone: string
}

/** True when the session opened; false when its workspace or agent is not usable. */
export function startAutomationEditWithAgent(input: StartAutomationEditWithAgentInput): boolean {
  const { automation, workspace } = input
  if (!workspace) {
    return false
  }
  const agent = resolveAutomationAgentStep(automation)?.agentId ?? input.fallbackAgentId
  const brief = buildAutomationAuthoringBrief({
    mode: 'edit',
    description: automationEditBriefOpening(automation.name),
    projectName: input.repo?.displayName ?? null,
    workspaceLabel: workspace.displayName,
    hostLabel: input.hostLabel,
    hostKind: input.hostKind,
    platform: input.platform,
    timezone: input.timezone,
    existing: {
      id: automation.id,
      name: automation.name,
      schedule: formatAutomationSchedule(automation.rrule),
      steps: automation.steps,
      prompt: automation.prompt,
      agentId: automation.agentId
    }
  })
  return launchAutomationAuthoringSession({
    agent,
    worktreeId: workspace.id,
    brief,
    automationName: automation.name
  })
}
