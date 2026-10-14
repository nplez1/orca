import type { Automation } from './automations-types'
import { getAutomationRunProjectId } from './automation-run-identity'
import type { ExecutionHostId } from './execution-host'
import type { TaskSourceContext } from './task-source-context'

/**
 * What an automation's assigned project supplies to a run.
 *
 * The stored record already carries the run target (`runContext`) and, when the
 * user pinned one, a task source. Neither reached the agent: every launch site
 * passed `automation.prompt` verbatim, so an automation assigned to a project ran
 * in that project's directory without ever being told which project it was.
 */

/** First line of the injected block; also how a second composition is recognised. */
export const AUTOMATION_PROJECT_CONTEXT_MARKER =
  '<!-- orca automation project context: supplied by the assigned project for every run -->'

/** The project fields the block reads off a repo, so main and the renderer can both pass one. */
export type AutomationProjectContextRepo = {
  id?: string | null
  displayName?: string | null
  path?: string | null
}

export type AutomationProjectContext = {
  projectId: string
  /** The project's name on the run host; null when the caller has no repo in hand. */
  projectName: string | null
  repoId: string | null
  hostId: ExecutionHostId | null
  path: string | null
  taskSource: Pick<TaskSourceContext, 'provider' | 'projectId' | 'accountLabel'> | null
}

/**
 * Derives the project context for a run, or null when the record names no project.
 *
 * `runContext` wins over the legacy repo-id field: it is the host-qualified target
 * the run resolves against, while `projectId` on a pre-host-context record is only
 * a repo id (see `run-target-resolution.ts`).
 */
export function getAutomationProjectContext(
  automation: Automation,
  repo?: AutomationProjectContextRepo | null
): AutomationProjectContext | null {
  const runContext = automation.runContext ?? null
  const projectId = getAutomationRunProjectId(automation)?.trim()
  if (!projectId) {
    return null
  }
  return {
    projectId,
    projectName: repo?.displayName?.trim() || null,
    repoId: runContext?.repoId?.trim() || repo?.id?.trim() || null,
    hostId: runContext?.hostId ?? null,
    path: runContext?.path?.trim() || repo?.path?.trim() || null,
    taskSource: automation.sourceContext
      ? {
          provider: automation.sourceContext.provider,
          projectId: automation.sourceContext.projectId,
          accountLabel: automation.sourceContext.accountLabel?.trim() || null
        }
      : null
  }
}

export function formatAutomationProjectContext(context: AutomationProjectContext): string {
  const project = context.projectName
    ? `${context.projectName} (${context.projectId})`
    : context.projectId
  const lines = [AUTOMATION_PROJECT_CONTEXT_MARKER, `Project: ${project}`]
  if (context.hostId) {
    lines.push(`Host: ${context.hostId}`)
  }
  if (context.path) {
    // Why the qualifier: this is the project's shared checkout (`setup.path`), while
    // the run's working directory is its own workspace — for `new_per_run`, a fresh
    // worktree. Left bare, "Path:" invites the agent to edit the shared checkout.
    lines.push(
      `Project root: ${context.path} (shared checkout, not necessarily this run's workspace)`
    )
  }
  if (context.taskSource) {
    const { provider, projectId: sourceProjectId, accountLabel } = context.taskSource
    // A repo-backed source ids itself `github:owner/repo`, which would read as a
    // duplicated provider here.
    const prefix = `${provider}:`
    const source = sourceProjectId.startsWith(prefix)
      ? sourceProjectId.slice(prefix.length)
      : sourceProjectId
    const account = accountLabel ? ` (account ${accountLabel})` : ''
    lines.push(`Task source: ${provider} ${source}${account}`)
  }
  return lines.join('\n')
}

/**
 * The prompt a run should hand its agent: the saved prompt prefixed with the
 * project's context, or the saved prompt untouched when the record names no
 * project. Callers keep their own trimming, so an unassigned automation stays
 * byte-identical to what it delivered before.
 *
 * A blank prompt stays blank: a launch with no instructions was a bare launch
 * before, and a context block is not a task.
 *
 * Composing twice is a no-op, so a caller that forwards an already-composed prompt
 * cannot nest the block.
 */
export function composeAutomationRunPrompt(
  automation: Automation,
  repo?: AutomationProjectContextRepo | null
): string {
  const prompt = automation.prompt ?? ''
  if (!prompt.trim()) {
    return prompt
  }
  const context = getAutomationProjectContext(automation, repo)
  if (!context) {
    return prompt
  }
  const block = formatAutomationProjectContext(context)
  return prompt.startsWith(block) ? prompt : `${block}\n\n${prompt.trim()}`
}
