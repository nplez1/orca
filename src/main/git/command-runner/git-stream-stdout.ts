import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { withGitSpan } from '../../observability/instrumentation'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import {
  deadlineOverrunMetadata,
  recordDeadlineOverrunOnSpan,
  terminateAtStalledDeadline
} from './stalled-deadline-kill'
import { pendingWslDriveCheckoutGitRouting } from '../wsl-drive-checkout-git-routing'
import type { ResolvedCommand } from './wsl-command-resolution'
import { DEFAULT_GIT_MAX_BUFFER, type GitExecOptions } from './git-exec-options'
import {
  pendingWslDirectGitReadEnvironment,
  directWslGitExitCode,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand,
  resolveGitCommandWithoutProbe
} from './git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import { prepareLocalLoginShellGitEnvironment } from './local-login-shell-git-environment'
import { nonInteractiveGitEnv, untranslatedGitOutputEnv } from './git-process-env'
import { gitSpawn } from './git-spawn'
import { acquireGitAdmission } from './git-subprocess-admission'
import { GitCommandTimeoutError, gitCommandTimeoutMs } from './git-command-timeout'
import type { GitStreamOptions, GitStreamResult } from './git-stream-options'
import { routeLocalGitOptions, runAdmittedWslGit } from './local-git-runtime-route'
import { gitRunsIn } from './git-runs-in'

export type { GitStreamOptions, GitStreamResult } from './git-stream-options'

/** Stream bounded stdout so large repositories cannot overflow V8 and parsers can stop early. */
export async function gitStreamStdout(
  args: string[],
  callerOptions: GitStreamOptions
): Promise<GitStreamResult> {
  const options = routeLocalGitOptions(callerOptions)
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
  const timeoutMs = gitCommandTimeoutMs(args, options.timeoutMs, options.timeoutMsForTest)
  return runAdmittedWslGit(options, () => streamInSpan(args, options, maxBuffer, timeoutMs))
}

function streamInSpan(
  args: string[],
  options: GitStreamOptions,
  maxBuffer: number,
  timeoutMs: number | undefined
): Promise<GitStreamResult> {
  return withGitSpan({ args, cwd: options.cwd }, async (span) => {
    const checkoutRoutingReady = pendingWslDriveCheckoutGitRouting(args, options)
    if (checkoutRoutingReady) {
      await checkoutRoutingReady
    }
    const gitOptions: GitExecOptions = {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.preferWslDirectGit ? { preferWslDirectGit: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    }
    const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, gitOptions)
    if (readEnvironmentReady) {
      await readEnvironmentReady
    }
    let resolved = resolveGitCommand(args, gitOptions)
    // Why local first: on POSIX only this one applies, and on Windows only the
    // other, so the two are mutually exclusive rather than layered.
    const environmentReady =
      prepareLocalLoginShellGitEnvironment(resolved, gitOptions.env, options.signal) ??
      prepareWindowsHostGitEnvironment(resolved, gitOptions.env, options.signal)
    if (environmentReady) {
      gitOptions.env = (await environmentReady) ?? gitOptions.env
    }
    resolved = resolveGitCommand(args, gitOptions)
    const grant = await acquireGitAdmission({
      args,
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.admissionTier,
      signal: options.signal
    })
    span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
    span?.setAttribute('git.runs_in', gitRunsIn(resolved))
    const terminationState: { current: Promise<void> | null } = { current: null }
    const stream = (command: ResolvedCommand): Promise<GitStreamResult> =>
      new Promise<GitStreamResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(createAbortError())
          return
        }
        const stdio: SpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe']
        const spawnOptions = {
          cwd: options.cwd,
          env: nonInteractiveGitEnv(gitOptions.env),
          stdio,
          wslDistro: options.wslDistro,
          windowsHide: true
        }
        let child: ChildProcess
        if (command.wslMode === 'direct-git') {
          const spawnStartedAt = performance.now()
          child = spawn(command.binary, command.args, {
            cwd: command.cwd,
            env: untranslatedGitOutputEnv(spawnOptions.env),
            stdio: spawnOptions.stdio,
            windowsHide: true
          })
          recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
        } else {
          child = gitSpawn(args, spawnOptions)
        }
        let terminationReported = false
        terminationState.current = new Promise<void>((resolveTermination) => {
          const reportTermination = (): void => {
            if (terminationReported) {
              return
            }
            terminationReported = true
            resolveTermination()
          }
          child.once('close', reportTermination)
          child.once('error', () => {
            if (!child.pid) {
              reportTermination()
            }
          })
        })

        let settled = false
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null
        let stoppedEarly = false
        let stdoutBytes = 0
        let stderr = ''
        let stderrBytes = 0
        // Decode across chunk boundaries to preserve split UTF-8 characters.
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')

        const cleanup = (): void => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          child.stdout?.off('data', onStdoutData)
          child.stderr?.off('data', onStderrData)
          child.off('error', onError)
          child.off('close', onClose)
          options.signal?.removeEventListener('abort', onAbort)
          stdoutDecoder.end()
          stderrDecoder.end()
        }
        const finish = (error: Error | null): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          if (error) {
            reject(Object.assign(error, { stderr, stdoutBytes }))
            return
          }
          resolve({ stoppedEarly })
        }

        function onStdoutData(chunk: Buffer): void {
          stdoutBytes += chunk.byteLength
          if (stdoutBytes > maxBuffer) {
            void killSpawnedCommandTree(child)
            finish(new Error('git stdout exceeded maxBuffer.'))
            return
          }
          const decoded = stdoutDecoder.write(chunk)
          if (decoded.length === 0) {
            return
          }
          // Reject parser failures rather than letting stream callbacks crash main.
          let shouldStop: boolean | void
          try {
            shouldStop = options.onStdout(decoded)
          } catch (error) {
            void killSpawnedCommandTree(child)
            finish(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (shouldStop === true) {
            stoppedEarly = true
            void killSpawnedCommandTree(child)
            finish(null)
          }
        }
        function onStderrData(chunk: Buffer): void {
          stderrBytes += chunk.byteLength
          if (stderrBytes > maxBuffer) {
            void killSpawnedCommandTree(child)
            finish(new Error('git stderr exceeded maxBuffer.'))
            return
          }
          stderr += stderrDecoder.write(chunk)
        }
        function onError(error: Error): void {
          finish(error)
        }
        function onClose(code: number | null): void {
          if (stoppedEarly || code === 0) {
            finish(null)
            return
          }
          finish(Object.assign(new Error(`git exited with ${code}: ${stderr}`), { code }))
        }
        function onAbort(): void {
          if (!child.pid) {
            // Why: failed spawn reports ENOENT after abort cleanup; retain a listener so it cannot crash main.
            child.once('error', () => {})
          }
          void killSpawnedCommandTree(child)
          finish(createAbortError())
        }

        function onTimeout(deadlineAt: number, timeoutMs: number): void {
          const overrunMs = performance.now() - deadlineAt
          terminateAtStalledDeadline({
            overrunMs,
            isSettled: () => settled,
            hasExited: () => child.exitCode != null || child.signalCode != null,
            terminate: () => {
              void killSpawnedCommandTree(child)
              finish(
                Object.assign(
                  new GitCommandTimeoutError(timeoutMs),
                  deadlineOverrunMetadata(overrunMs)
                )
              )
            }
          })
        }

        child.stdout?.on('data', onStdoutData)
        child.stderr?.on('data', onStderrData)
        child.on('error', onError)
        child.on('close', onClose)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (timeoutMs !== undefined && timeoutMs > 0) {
          const deadlineAt = performance.now() + timeoutMs
          timeoutTimer = setTimeout(() => onTimeout(deadlineAt, timeoutMs), timeoutMs)
        }
        if (options.signal?.aborted) {
          onAbort()
        }
      })
    try {
      try {
        return await stream(resolved)
      } catch (error) {
        recordDeadlineOverrunOnSpan(span, error)
        const stdoutBytes =
          error && typeof error === 'object'
            ? (error as { stdoutBytes?: unknown }).stdoutBytes
            : null
        if (
          stdoutBytes === 0 &&
          directWslGitExitCode(error, resolved) !== null &&
          !options.signal?.aborted
        ) {
          await terminationState.current
          const wasMissing = invalidateMissingDirectWslGit(error, resolved)
          resolved = resolveGitCommandWithoutProbe(args, gitOptions)
          const result = await stream(resolved).catch((retryError: unknown) => {
            recordDeadlineOverrunOnSpan(span, retryError)
            throw retryError
          })
          disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
          return result
        }
        throw error
      }
    } finally {
      const termination = terminationState.current
      if (termination) {
        void termination.then(grant.release)
      } else {
        grant.release()
      }
    }
  })
}
