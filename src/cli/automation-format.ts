/**
 * Human-readable automation output for the CLI.
 *
 * The host lines come from the authority's own projection, never from the
 * stored `executionTarget*` fields: a target that was removed — or removed and
 * re-registered under the same id — leaves those fields untouched, so printing
 * them alone would render a dead host identically to a healthy one and leave
 * `orca automations show` unable to complete the recovery it is named in.
 */

import type { Automation, AutomationRun } from '../shared/automations-types'
import type { AutomationListItem } from '../shared/automation-list-scope'
import type { AutomationOwnerPrecondition } from '../shared/automation-owner-precondition'
import { getAutomationLegacyRepoId } from '../shared/automation-run-identity'
import { formatAutomationPrecheckTimeout } from '../shared/automation-precheck'
import { formatAutomationSchedule } from '../shared/automation-schedules'
import {
  formatAutomationStepsSummary,
  resolveAutomationAgentStep,
  resolveAutomationSteps
} from '../shared/automation-steps'

export type AutomationListPayload = {
  automations: Automation[]
  /** Present only when the authority qualifies its rows; an older host sends none. */
  items?: AutomationListItem[]
}

export type AutomationShowPayload = {
  automation: Automation
  /** Present only when the authority can project an owner; an older host sends none. */
  owner?: AutomationOwnerPrecondition
}

const ORPHAN_HOST_LABEL = 'orphan (no host can run this automation)'

function formatOwnerSelector(selector: AutomationOwnerPrecondition['selector']): string {
  if (selector.kind === 'ssh') {
    return `ssh:${selector.targetId} (generation ${selector.targetGeneration})`
  }
  return selector.kind === 'orphan' ? ORPHAN_HOST_LABEL : 'self'
}

function formatListItemSelector(item: AutomationListItem): string {
  const selector = item.selector
  if (selector.kind === 'ssh') {
    return `ssh:${selector.targetId} (generation ${selector.targetGeneration})`
  }
  return selector.kind === 'orphan' ? `orphan — ${selector.issue}` : 'self'
}

export function formatAutomationList(result: AutomationListPayload): string {
  if (result.automations.length === 0) {
    return 'No automations found.'
  }
  const hosts = new Map(result.items?.map((item) => [item.automationId, item]) ?? [])
  return result.automations
    .map((automation) => {
      const status = automation.enabled ? 'enabled' : 'disabled'
      const item = hosts.get(automation.id)
      const host = item ? `\nhost: ${formatListItemSelector(item)}` : ''
      return `${automation.id}  ${automation.name}  ${automation.agentId}  ${status}\n${formatAutomationSchedule(automation.rrule)}  next: ${new Date(automation.nextRunAt).toISOString()}${host}`
    })
    .join('\n\n')
}

export function formatAutomationShow(result: AutomationShowPayload): string {
  const automation = result.automation
  const runContext = automation.runContext ?? null
  const projectLines = runContext
    ? [
        `runProjectId: ${runContext.projectId}`,
        `runHostId: ${runContext.hostId}`,
        `projectHostSetupId: ${runContext.projectHostSetupId}`,
        `runRepoId: ${runContext.repoId}`,
        `runPath: ${runContext.path}`,
        `legacyRepoId: ${getAutomationLegacyRepoId(automation)}`
      ]
    : [`legacyRepoId: ${getAutomationLegacyRepoId(automation)}`]
  const agentStep = resolveAutomationAgentStep(automation)
  return [
    `id: ${automation.id}`,
    `name: ${automation.name}`,
    // The plan replaces the flat prompt/provider pair as the record's source of truth,
    // so it is what a reader (or an agent about to edit it) has to see.
    `steps: ${formatAutomationStepsSummary(automation)}`,
    ...automationStepLines(automation),
    ...(agentStep ? [`provider: ${agentStep.agentId}`] : []),
    ...(automation.extraAgentArgs ? [`extraAgentArgs: ${automation.extraAgentArgs}`] : []),
    `enabled: ${automation.enabled}`,
    `schedule: ${formatAutomationSchedule(automation.rrule)}`,
    `rrule: ${automation.rrule}`,
    `precheck: ${
      automation.precheck
        ? `${automation.precheck.command} (timeout ${formatAutomationPrecheckTimeout(
            automation.precheck.timeoutSeconds
          )})`
        : 'none'
    }`,
    `nextRunAt: ${new Date(automation.nextRunAt).toISOString()}`,
    ...projectLines,
    `workspaceMode: ${automation.workspaceMode}`,
    `workspaceId: ${automation.workspaceId ?? 'null'}`,
    `baseBranch: ${automation.baseBranch ?? 'null'}`,
    `reuseSession: ${automation.reuseSession}`,
    `target: ${automation.executionTargetType}:${automation.executionTargetId}`,
    // Omitted rather than guessed: a host that reports no owner has none to report.
    ...(result.owner ? [`host: ${formatOwnerSelector(result.owner.selector)}`] : []),
    ...(agentStep ? [`prompt: ${agentStep.prompt}`] : [])
  ].join('\n')
}

/** One line per step, numbered, with the flags that decide how it runs. */
function automationStepLines(automation: Automation): string[] {
  return resolveAutomationSteps(automation).map((step, index) =>
    step.kind === 'script'
      ? `step ${index + 1}: script (timeout ${formatAutomationPrecheckTimeout(step.timeoutSeconds)}, onFailure ${step.onFailure})\n  ${step.command}`
      : `step ${index + 1}: agent ${step.agentId}\n  ${step.prompt}`
  )
}

export function formatAutomationRemoved(result: { removed: boolean; id: string }): string {
  return result.removed
    ? `Removed automation ${result.id}.`
    : `Automation ${result.id} not removed.`
}

export function formatAutomationRun(result: { run: AutomationRun }): string {
  return [
    `id: ${result.run.id}`,
    `automationId: ${result.run.automationId}`,
    `title: ${result.run.title}`,
    `status: ${result.run.status}`,
    `trigger: ${result.run.trigger}`,
    `scheduledFor: ${new Date(result.run.scheduledFor).toISOString()}`,
    `workspaceId: ${result.run.workspaceId ?? 'null'}`,
    `precheck: ${formatAutomationRunPrecheck(result.run)}`,
    ...formatAutomationRunSteps(result.run),
    `error: ${result.run.error ?? 'null'}`
  ].join('\n')
}

/** What each script step did, so a finished run explains itself without the log. */
function formatAutomationRunSteps(run: AutomationRun): string[] {
  if (!run.stepResults || run.stepResults.length === 0) {
    return []
  }
  return [
    `steps: ${run.stepResults.map((result) => `${result.index + 1}:${result.status}`).join(', ')}`,
    ...run.stepResults.map((result) => {
      const outcome = result.timedOut
        ? 'timed out'
        : result.error
          ? `error: ${result.error}`
          : `exit ${result.exitCode ?? 'unknown'}`
      return `  step ${result.index + 1} (${result.label}): ${outcome}`
    })
  ]
}

function formatAutomationRunPrecheck(run: AutomationRun): string {
  const result = run.precheckResult
  if (!result) {
    return 'none'
  }
  const outcome = result.timedOut
    ? 'timed out'
    : result.error
      ? 'error'
      : `exit ${result.exitCode ?? 'unknown'}`
  const output = result.stderr.trim() || result.stdout.trim()
  return output ? `${outcome}; ${output}` : outcome
}

export function formatAutomationRuns(result: { runs: AutomationRun[] }): string {
  if (result.runs.length === 0) {
    return 'No automation runs found.'
  }
  return result.runs
    .map(
      (run) =>
        `${run.id}  ${run.automationId}  ${run.status}  ${run.trigger}  ${new Date(run.scheduledFor).toISOString()}\n${run.title}${run.precheckResult ? `\nprecheck: ${formatAutomationRunPrecheck(run)}` : ''}${run.stepResults?.length ? `\nsteps: ${run.stepResults.map((result) => `${result.index + 1}:${result.status}`).join(', ')}` : ''}${run.error ? `\nerror: ${run.error}` : ''}`
    )
    .join('\n\n')
}
