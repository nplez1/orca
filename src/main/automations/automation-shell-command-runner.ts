/**
 * One inline shell command, run where the automation's workspace lives.
 *
 * This is the executor both kinds of imperative work share: the automation's
 * `precheck` gate, and every `script` step in a plan. They answer different
 * questions — a gate decides whether to start an agent, a script step *is* the
 * work — but they run the same way, so they run through the same code: a bounded
 * tail of output, a timeout that is judged before the exit code, and a process
 * tree that is actually stopped. The timed-out-before-exit-code rule is the one
 * `classifyHookProcessResult` states: the exit code of something we cut off is not
 * evidence that it finished.
 *
 * Local commands go through the shared process host with the shell named
 * explicitly, which is what keeps Windows argument encoding and `windowsHide`
 * out of this module's hands. They also run with the unattended-environment
 * guard, because a script step that waits on a credential prompt is a run that
 * never ends.
 */

import type { ClientChannel } from 'ssh2'
import { runProcess } from '@orca/process-host'
import { promptGuardShellEnv } from '../git/runner'
import { getSshConnectionManager } from '../ssh/ssh-target-registry'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { errorMessage } from '../../shared/error-message'

/** Bounded so a chatty build cannot retain its whole log on every run record. */
export const MAX_AUTOMATION_STEP_OUTPUT_BYTES = 16 * 1024

export type AutomationShellCommandTarget =
  | { type: 'local'; cwd: string }
  | { type: 'ssh'; cwd: string; connectionId: string }

export type AutomationShellCommandOutcome = {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type AutomationShellCommandInput = {
  command: string
  timeoutSeconds: number
  target: AutomationShellCommandTarget
}

/** What the shell a command runs under is on this platform, named explicitly. */
export function automationCommandShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): { program: string; args: readonly string[] } {
  if (platform === 'win32') {
    return { program: environment.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  // `sh`, not the user's login shell: the command was authored for the plain
  // POSIX shell, and a login shell would load profiles that can print to stdout.
  return { program: '/bin/sh', args: ['-c'] }
}

function finish(
  startedAt: number,
  result: {
    exitCode: number | null
    timedOut: boolean
    stdout: string
    stderr: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
    error: string | null
  }
): AutomationShellCommandOutcome {
  const completedAt = Date.now()
  return {
    ...result,
    durationMs: Math.max(0, completedAt - startedAt),
    startedAt,
    completedAt
  }
}

async function runLocalCommand(input: {
  command: string
  timeoutSeconds: number
  cwd: string
}): Promise<AutomationShellCommandOutcome> {
  const startedAt = Date.now()
  const shell = automationCommandShell()
  try {
    const result = await runProcess(
      {
        program: shell.program,
        args: [...shell.args, input.command],
        cwd: input.cwd,
        env: promptGuardShellEnv(process.env),
        timeoutMs: input.timeoutSeconds * 1000,
        maxOutputBytes: MAX_AUTOMATION_STEP_OUTPUT_BYTES
      },
      'tail'
    )
    return finish(startedAt, {
      // Why the timeout withholds the code: a command that traps the signal and
      // exits 0 reports success for work that was cut off mid-flight.
      exitCode: result.timedOut ? null : result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.outputTruncated === true,
      stderrTruncated: result.outputTruncated === true,
      error: null
    })
  } catch (error) {
    return finish(startedAt, {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: errorMessage(error)
    })
  }
}

function runSshChannelCommand(input: {
  command: string
  timeoutSeconds: number
  channel: ClientChannel
  startedAt: number
}): Promise<AutomationShellCommandOutcome> {
  const { channel, startedAt } = input
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(
        finish(startedAt, {
          exitCode: timedOut ? null : exitCode,
          timedOut,
          stdout,
          stderr,
          stdoutTruncated: stdout.length >= MAX_AUTOMATION_STEP_OUTPUT_BYTES,
          stderrTruncated: stderr.length >= MAX_AUTOMATION_STEP_OUTPUT_BYTES,
          error
        })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      channel.close()
    }, input.timeoutSeconds * 1000)

    const fail = (error: Error): void => settle(error.message)
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', (data: Buffer | string) => {
      stdout = appendBounded(stdout, data.toString())
    })
    channel.stderr.on('data', (data: Buffer | string) => {
      stderr = appendBounded(stderr, data.toString())
    })
    channel.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', (code?: number | null) => {
      if (typeof code === 'number') {
        exitCode = code
      }
      settle(null)
    })
  })
}

/** Keeps the tail: the end of a log is what explains a failure. */
function appendBounded(current: string, chunk: string): string {
  const next = `${current}${chunk}`
  return next.length <= MAX_AUTOMATION_STEP_OUTPUT_BYTES
    ? next
    : next.slice(-MAX_AUTOMATION_STEP_OUTPUT_BYTES)
}

async function runSshCommand(input: {
  command: string
  timeoutSeconds: number
  cwd: string
  connectionId: string
}): Promise<AutomationShellCommandOutcome> {
  const startedAt = Date.now()
  const connection = getSshConnectionManager()?.getConnection(input.connectionId)
  if (!connection || connection.getState().status !== 'connected') {
    return finish(startedAt, {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: 'SSH target is not connected.'
    })
  }
  try {
    const channel = await connection.exec(`cd ${shellEscape(input.cwd)} && ${input.command}`)
    return await runSshChannelCommand({
      command: input.command,
      timeoutSeconds: input.timeoutSeconds,
      channel,
      startedAt
    })
  } catch (error) {
    return finish(startedAt, {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: errorMessage(error)
    })
  }
}

export async function runAutomationShellCommand(
  input: AutomationShellCommandInput
): Promise<AutomationShellCommandOutcome> {
  if (input.target.type === 'ssh') {
    return await runSshCommand({
      command: input.command,
      timeoutSeconds: input.timeoutSeconds,
      cwd: input.target.cwd,
      connectionId: input.target.connectionId
    })
  }
  return await runLocalCommand({
    command: input.command,
    timeoutSeconds: input.timeoutSeconds,
    cwd: input.target.cwd
  })
}

/** The one sentence a failed command owes a run row, whatever the failure was. */
export function describeAutomationCommandFailure(
  outcome: AutomationShellCommandOutcome,
  timeoutSeconds: number
): string {
  if (outcome.timedOut) {
    return `Timed out after ${timeoutSeconds}s.`
  }
  if (outcome.error) {
    return outcome.error
  }
  return `Exited with code ${outcome.exitCode ?? 'unknown'}.`
}
