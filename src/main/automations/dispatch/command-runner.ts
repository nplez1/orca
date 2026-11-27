// One shell command on a host: a local spawn or an SSH channel, with a timeout, a tree kill, and a
// tail-truncated capture. Prechecks and command automations both run through it.
import { spawn, type ChildProcess } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import type { AutomationPrecheckResult } from '../../../shared/automations/history/automation-run'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../../shared/automations/launch/automation-precheck'
import { getSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { errorMessage } from '../../../shared/errors/error-message'
import { killLocalCommandProcessTree, type HostCommandKillSite } from './command-process-tree-kill'

/** A command as it is stored: one shell string and its own deadline. */
export type HostCommand = {
  command: string
  timeoutSeconds: number
}

/** `login` runs it through the host's login shell, so ~/.zshenv and ~/.zprofile apply. */
export type HostCommandShell = 'plain' | 'login'

export type HostCommandTarget =
  | {
      type: 'local'
      cwd: string
    }
  | {
      type: 'ssh'
      cwd: string
      connectionId: string
    }

/** The capture a run stores; a precheck's own record is the same shape. */
export type HostCommandResult = AutomationPrecheckResult

export type HostCommandRun = {
  command: HostCommand
  /** Absent is `plain`: the shell a precheck has always used. */
  shell?: HostCommandShell
  /** Names the command in a timeout message, as in "Precheck timed out after 60s." */
  label: string
  killSite: HostCommandKillSite
  /** Aborting kills the command as a timeout would. */
  signal?: AbortSignal
}

type TailBuffer = {
  content: string
  truncated: boolean
}

function appendTail(buffer: TailBuffer, chunk: string): TailBuffer {
  const content = `${buffer.content}${chunk}`
  if (content.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS) {
    return { ...buffer, content }
  }
  return {
    content: content.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS),
    truncated: true
  }
}

function timeoutMessage(run: HostCommandRun): string {
  return `${run.label} timed out after ${run.command.timeoutSeconds}s.`
}

function stoppedMessage(run: HostCommandRun): string {
  return `${run.label} was stopped before it finished.`
}

function createCommandResult(
  run: HostCommandRun,
  args: {
    startedAt: number
    stdout: TailBuffer
    stderr: TailBuffer
    exitCode: number | null
    timedOut: boolean
    error: string | null
  }
): HostCommandResult {
  const completedAt = Date.now()
  return {
    command: run.command.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    durationMs: Math.max(0, completedAt - args.startedAt),
    stdout: args.stdout.content,
    stderr: args.stderr.content,
    stdoutTruncated: args.stdout.truncated,
    stderrTruncated: args.stderr.truncated,
    error: args.error,
    startedAt: args.startedAt,
    completedAt
  }
}

/** A command that never started: the host refused it, or no channel could be opened. */
export function failedCommandResult(
  run: HostCommandRun,
  startedAt: number,
  error: string
): HostCommandResult {
  return createCommandResult(run, {
    startedAt,
    stdout: { content: '', truncated: false },
    stderr: { content: '', truncated: false },
    exitCode: null,
    timedOut: false,
    error
  })
}

/** The local spawn for a shell mode; Windows has no login shell, so it always spawns plainly. */
function spawnLocalCommand(
  run: HostCommandRun,
  target: Extract<HostCommandTarget, { type: 'local' }>
): ChildProcess {
  const detached = process.platform !== 'win32'
  if (run.shell === 'login' && process.platform !== 'win32') {
    return spawn(process.env.SHELL || '/bin/sh', ['-lc', run.command.command], {
      cwd: target.cwd,
      detached,
      env: process.env,
      windowsHide: true
    })
  }
  return spawn(run.command.command, {
    cwd: target.cwd,
    detached,
    env: process.env,
    shell: true,
    windowsHide: true
  })
}

function runLocalCommand(
  run: HostCommandRun,
  target: Extract<HostCommandTarget, { type: 'local' }>
): Promise<HostCommandResult> {
  const startedAt = Date.now()
  const timeoutMs = run.command.timeoutSeconds * 1000
  if (run.signal?.aborted) {
    return Promise.resolve(failedCommandResult(run, startedAt, stoppedMessage(run)))
  }
  return new Promise((resolve) => {
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
    let timedOut = false
    let stopped = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawnLocalCommand(run, target)

    const abort = (): void => {
      stopped = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      forceKillTimer ??= killLocalCommandProcessTree(child, run.killSite)
    }
    run.signal?.addEventListener('abort', abort, { once: true })

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      run.signal?.removeEventListener('abort', abort)
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      resolve(createCommandResult(run, { startedAt, stdout, stderr, exitCode, timedOut, error }))
    }

    timeout = setTimeout(() => {
      timedOut = true
      forceKillTimer = killLocalCommandProcessTree(child, run.killSite)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendTail(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendTail(stderr, chunk)
    })
    child.on('error', (error) => {
      settle(null, error.message)
    })
    child.on('close', (code) => {
      const error = timedOut ? timeoutMessage(run) : stopped ? stoppedMessage(run) : null
      settle(timedOut || stopped || typeof code !== 'number' ? null : code, error)
    })
  })
}

function runSshChannelCommand(
  run: HostCommandRun,
  args: { channel: ClientChannel; startedAt: number }
): Promise<HostCommandResult> {
  const { channel, startedAt } = args
  const timeoutMs = run.command.timeoutSeconds * 1000
  return new Promise((resolve) => {
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
    let exitCode: number | null = null
    let timedOut = false
    let stopped = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const abort = (): void => {
      stopped = true
      channel.close()
    }

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      run.signal?.removeEventListener('abort', abort)
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(createCommandResult(run, { startedAt, stdout, stderr, exitCode, timedOut, error }))
    }

    timeout = setTimeout(() => {
      timedOut = true
      channel.close()
    }, timeoutMs)
    run.signal?.addEventListener('abort', abort, { once: true })

    const fail = (error: Error): void => {
      settle(null, error.message)
    }
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', (data: Buffer | string) => {
      stdout = appendTail(stdout, data.toString())
    })
    channel.stderr.on('data', (data: Buffer | string) => {
      stderr = appendTail(stderr, data.toString())
    })
    channel.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', (code?: number | null) => {
      if (typeof code === 'number') {
        exitCode = code
      }
      const error = timedOut ? timeoutMessage(run) : stopped ? stoppedMessage(run) : null
      settle(exitCode, error)
    })
    // Stopped while the channel was opening; its listeners are attached by now.
    if (run.signal?.aborted) {
      abort()
    }
  })
}

/** The remote line: a login run asks the host's own shell, so the login files are read there too. */
function remoteCommandLine(
  run: HostCommandRun,
  target: Extract<HostCommandTarget, { type: 'ssh' }>
): string {
  // /bin/sh expands $SHELL, since the account's own shell may not read `${SHELL:-…}`.
  const line =
    run.shell === 'login'
      ? `/bin/sh -c ${quotePosixShell(`exec "\${SHELL:-/bin/sh}" -lc ${quotePosixShell(run.command.command)}`)}`
      : run.command.command
  // Its own statement: after `cd … &&`, a command's `||` branch would run in the wrong directory.
  return `cd ${quotePosixShell(target.cwd)} || exit 1\n${line}`
}

async function runSshCommand(
  run: HostCommandRun,
  target: Extract<HostCommandTarget, { type: 'ssh' }>
): Promise<HostCommandResult> {
  const startedAt = Date.now()
  const manager = getSshConnectionManager()
  const connection = manager?.getConnection(target.connectionId)
  if (!connection || connection.getState().status !== 'connected') {
    return failedCommandResult(run, startedAt, 'SSH target is not connected.')
  }
  try {
    const channel = await connection.execWithClosedStdin(remoteCommandLine(run, target))
    return await runSshChannelCommand(run, { channel, startedAt })
  } catch (error) {
    return failedCommandResult(run, startedAt, errorMessage(error))
  }
}

/** Runs one command on its host and resolves with the capture, never throwing for a failed command. */
export async function runHostCommand(
  run: HostCommandRun,
  target: HostCommandTarget
): Promise<HostCommandResult> {
  if (target.type === 'ssh') {
    return await runSshCommand(run, target)
  }
  return await runLocalCommand(run, target)
}
