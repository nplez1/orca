/**
 * The automation's gate, as the service runs it.
 *
 * A precheck is one shell command whose exit status decides whether the run starts
 * at all; the execution belongs to `automation-shell-command-runner.ts`, which the
 * plan's script steps use too. What stays here is the gate's own shape: the
 * command is echoed back onto the result, and the output is bounded to the gate's
 * smaller budget because a gate's output is a diagnostic, not a log.
 */

import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'
import {
  runAutomationShellCommand,
  type AutomationShellCommandTarget
} from './automation-shell-command-runner'

type AutomationPrecheckExecutionTarget =
  | { type: 'local'; cwd: string }
  | { type: 'ssh'; cwd: string; connectionId: string }

function boundTail(value: string): { content: string; truncated: boolean } {
  if (value.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS) {
    return { content: value, truncated: false }
  }
  return { content: value.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS), truncated: true }
}

export async function runAutomationPrecheck(args: {
  precheck: AutomationPrecheck
  target: AutomationPrecheckExecutionTarget
}): Promise<AutomationPrecheckResult> {
  const target: AutomationShellCommandTarget =
    args.target.type === 'ssh'
      ? { type: 'ssh', cwd: args.target.cwd, connectionId: args.target.connectionId }
      : { type: 'local', cwd: args.target.cwd }
  const outcome = await runAutomationShellCommand({
    command: args.precheck.command,
    timeoutSeconds: args.precheck.timeoutSeconds,
    target
  })
  const stdout = boundTail(outcome.stdout)
  const stderr = boundTail(outcome.stderr)
  return {
    command: args.precheck.command,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: outcome.stdoutTruncated || stdout.truncated,
    stderrTruncated: outcome.stderrTruncated || stderr.truncated,
    // The gate's own sentence: run history and the skip reason both quote it.
    error: outcome.timedOut
      ? `Precheck timed out after ${args.precheck.timeoutSeconds}s.`
      : outcome.error,
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt
  }
}
