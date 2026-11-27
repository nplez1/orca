// A command automation's run: no session, no agent — one command, its capture, and a recorded outcome.
import type {
  Automation,
  AutomationScript
} from '../../../shared/automations/automation-definition'
import { requireAutomationScript } from '../../../shared/automations/launch/automation-command'
import { errorMessage } from '../../../shared/errors/error-message'
import { runHostCommand, type HostCommandResult } from './command-runner'
import type { AutomationLaunchContext } from './automation-launch-runner'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'

const MAX_COMMAND_ERROR_STDERR_CHARS = 2000

/** Where the command runs: the resolved target's own directory, local or over SSH. */
export type AutomationCommandTarget = {
  cwd: string
  sshConnectionId?: string
}

type AutomationCommandRun = {
  automation: Automation
  target: AutomationCommandTarget
  /** Aborted when the scheduler stops, which kills the command. */
  signal: AbortSignal
  transition: AutomationLaunchContext['transition']
}

/** The reason and the stderr tail, kept even when the report stores no output. */
function describeCommandFailure(result: HostCommandResult, timeoutSeconds: number): string {
  const reason = result.timedOut
    ? `Command timed out after ${timeoutSeconds}s.`
    : result.error
      ? `Command failed: ${result.error}`
      : `Command exited with code ${result.exitCode ?? 'unknown'}.`
  const stderr = result.stderr.trim().slice(-MAX_COMMAND_ERROR_STDERR_CHARS)
  return stderr ? `${reason}\n${stderr}` : reason
}

/** `silent` keeps no output; every other report stores what the command printed on the run. */
function keptOutput(script: AutomationScript, result: HostCommandResult): string | null {
  if (script.report === 'silent') {
    return null
  }
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n') || null
}

async function runAutomationCommand(args: AutomationCommandRun): Promise<void> {
  const script = requireAutomationScript(args.automation)
  const startedAt = Date.now()
  const result = await runHostCommand(
    {
      command: { command: script.command, timeoutSeconds: script.timeoutSeconds },
      shell: script.shell,
      label: 'Command',
      killSite: 'automation-command-timeout',
      signal: args.signal
    },
    args.target.sshConnectionId
      ? { type: 'ssh', cwd: args.target.cwd, connectionId: args.target.sshConnectionId }
      : { type: 'local', cwd: args.target.cwd }
  )
  const failed = result.timedOut || result.error !== null || result.exitCode !== 0
  const output = keptOutput(script, result)
  await args.transition({
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
  }).run
}

async function recordCommandRunError(args: AutomationCommandRun, error: unknown): Promise<void> {
  // A stopped service or removed automation leaves the row for startup to settle.
  if (error instanceof AutomationDispatchCancelledError) {
    return
  }
  console.error('[automations] command run failed:', error)
  await args.transition({ status: 'dispatch_failed', error: errorMessage(error) }).run
}

/** Detached from the dispatch lane: a command can run for as long as its timeout. */
export function startAutomationCommandRun(args: AutomationCommandRun): void {
  void runAutomationCommand(args)
    .catch((error: unknown) => recordCommandRunError(args, error))
    .catch((writeError: unknown) => {
      if (!(writeError instanceof AutomationDispatchCancelledError)) {
        console.error('[automations] could not record a command run:', writeError)
      }
    })
}
