import type { Automation, AutomationRun } from '../../shared/automations-types'
import { composeAutomationRunPrompt } from '../../shared/automation-project-context'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type HeadlessAutomationRunForWorkspace = Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
type RuntimeCreateManagedWorktreeArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

export function buildHeadlessAutomationWorkspaceName(
  runTitle: string,
  scheduledFor: number
): string {
  // Why: generated workspace names must stay deterministic and short enough for
  // cross-provider branch/path displays while still carrying the run timestamp.
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').slice(0, 13)
  return `auto-${slug || 'run'}-${stamp}`
}

export function buildHeadlessAutomationWorktreeCreateArgs({
  automation,
  run,
  repo,
  createdAt = Date.now()
}: {
  automation: Automation
  run: HeadlessAutomationRunForWorkspace
  repo: Repo
  createdAt?: number
}): RuntimeCreateManagedWorktreeArgs {
  return {
    repoSelector: repo.id,
    name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor),
    baseBranch: automation.baseBranch ?? undefined,
    setupDecision: automation.setupDecision ?? 'skip',
    activate: false,
    createdWithAgent: automation.agentId,
    startupAgent: automation.agentId,
    // Composed for the same reason as the launch: the create contract must not ship a context-less prompt.
    startupPrompt: composeAutomationRunPrompt(automation, repo),
    ...(automation.extraAgentArgs ? { startupExtraAgentArgs: automation.extraAgentArgs } : {}),
    telemetrySource: 'unknown',
    automationProvenance: buildAutomationWorkspaceProvenance(automation, run, repo, createdAt)
  }
}
