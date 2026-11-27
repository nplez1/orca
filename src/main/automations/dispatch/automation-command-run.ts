// A command automation's run: no session, no agent — one command, its capture, and a recorded outcome.
import type { Automation, AutomationScript } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { requireAutomationScript } from '../../../shared/automations/launch/automation-command'
import { runHostCommand, type HostCommandResult } from './command-runner'
import type { AutomationRunWriter } from '../run-history/run-writer'

/** Where the command runs: the resolved target's own directory, local or over SSH. */
export type AutomationCommandTarget = {
  cwd: string
  sshConnectionId?: string
}

function describeCommandFailure(result: HostCommandResult, timeoutSeconds: number): string {
  if (result.timedOut) {
    return `Command timed out after ${timeoutSeconds}s.`
  }
  if (result.error) {
    return `Command failed: ${result.error}`
  }
  return `Command exited with code ${result.exitCode ?? 'unknown'}.`
}

/** `silent` keeps no output; every other report stores what the command printed on the run. */
function keptOutput(script: AutomationScript, result: HostCommandResult): string | null {
  if (script.report === 'silent') {
    return null
  }
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n') || null
}

export async function runAutomationCommandRun(args: {
  automation: Automation
  run: AutomationRun
  target: AutomationCommandTarget
  runs: AutomationRunWriter
}): Promise<AutomationRun> {
  const script = requireAutomationScript(args.automation)
  const startedAt = Date.now()
  const result = await runHostCommand(
    {
      command: { command: script.command, timeoutSeconds: script.timeoutSeconds },
      shell: script.shell,
      label: 'Command',
      killSite: 'automation-command-timeout'
    },
    args.target.sshConnectionId
      ? { type: 'ssh', cwd: args.target.cwd, connectionId: args.target.sshConnectionId }
      : { type: 'local', cwd: args.target.cwd }
  )
  const failed = result.timedOut || result.error !== null || result.exitCode !== 0
  const output = keptOutput(script, result)
  return await args.runs.updateRun({
    runId: args.run.id,
    status: failed ? 'dispatch_failed' : 'completed',
    sessionKind: 'script',
    workspaceId: args.automation.workspaceId,
    dispatchedAt: startedAt,
    exitCode: result.exitCode,
    outputSnapshot: output
      ? {
          format: 'plain_text',
          content: output,
          capturedAt: Date.now(),
          truncated: result.stdoutTruncated || result.stderrTruncated
        }
      : null,
    error: failed ? describeCommandFailure(result, script.timeoutSeconds) : null
  })
}
