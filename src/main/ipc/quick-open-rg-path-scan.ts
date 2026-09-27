import { fileListingCancellationError } from '../../shared/file-listing-cancellation'
import {
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath,
  type RgOutputMode
} from '../../shared/quick-open-filter'
import {
  absorbPendingRipgrepSpawnError,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError,
  RipgrepLaunchFailureError,
  RipgrepUnavailableError
} from '../../shared/ripgrep-process-availability'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import { QuickOpenSubprocessPathAccumulator } from '../../shared/quick-open-listing-limits'
import { toWindowsWslPath } from '../wsl'

/**
 * One bounded ripgrep `--files` walk, streaming each surviving path into `onPath`.
 * Shared by the query-scoped search (a matcher consumes paths) and the path inventory
 * (a collector stores them), so the WSL translation, blocklist, cancellation, timeout, and
 * transient-launch retry rules cannot drift between the two.
 *
 * `onPath` returns false to stop the walk early; the inventory uses that to enforce its budget.
 */
export function scanRipgrepPaths(args: {
  args: string[]
  authorizedRootPath: string
  excludePathPrefixes: readonly string[]
  localGitOptions: { wslDistro?: string }
  onPath?: (path: string) => boolean
  onPathBatch?: (paths: readonly string[]) => Promise<boolean>
  batchSize?: number
  batchByteLimit?: number
  timeoutMilliseconds?: number
  signal?: AbortSignal
  wslDistroForOutput?: string
}): Promise<void> {
  if (!args.onPath && !args.onPathBatch) {
    return Promise.reject(new TypeError('Path scan requires a consumer'))
  }
  if (args.onPath && args.onPathBatch) {
    return Promise.reject(new TypeError('Path scan accepts only one consumer'))
  }
  if (args.signal?.aborted) {
    return Promise.reject(fileListingCancellationError(args.signal))
  }
  return new Promise((resolve, reject) => {
    const pathAccumulator = new QuickOpenSubprocessPathAccumulator(0x0a)
    const batchSize = Math.max(1, Math.floor(args.batchSize ?? 256))
    const batchByteLimit = Math.max(1, Math.floor(args.batchByteLimit ?? 512 * 1024))
    const pendingBatch: string[] = []
    let pendingBatchBytes = 0
    let batchFlush: Promise<void> | null = null
    let done = false
    let stopRequested = false
    let parseablePathCount = 0
    let processErrorObserved = false
    let unavailableExitObserved = false
    let child: ReturnType<typeof spawnBundledRipgrep>
    try {
      child = spawnBundledRipgrep(args.args, {
        cwd: args.authorizedRootPath,
        wslDistro: args.localGitOptions.wslDistro,
        wslDistroForOutput: args.wslDistroForOutput,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      // Why route through the classifier: a sync throw skips the 'error' handler, and ENOTDIR --
      // a search root that is a file -- should read the same here as it does there.
      void classifySynchronousRipgrepSpawnFailure(error, args.authorizedRootPath).then(
        reject,
        reject
      )
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const timeoutMilliseconds = Math.max(1, args.timeoutMilliseconds ?? 10_000)

    const processLine = (rawLine: string): void => {
      const translated =
        args.wslDistroForOutput && rawLine.startsWith('/')
          ? toWindowsWslPath(rawLine, args.wslDistroForOutput)
          : rawLine
      const relPath = normalizeQuickOpenRgLine(
        translated,
        getOutputMode(rawLine, translated, args.authorizedRootPath)
      )
      if (relPath === null) {
        return
      }
      parseablePathCount++
      if (args.onPathBatch) {
        const pathBytes = Buffer.byteLength(relPath, 'utf8')
        if (pendingBatch.length > 0 && pendingBatchBytes + pathBytes > batchByteLimit) {
          startBatchFlush()
        }
        pendingBatch.push(relPath)
        pendingBatchBytes += pathBytes
        if (pendingBatch.length >= batchSize || pendingBatchBytes >= batchByteLimit) {
          startBatchFlush()
        }
      } else if (
        shouldIncludeQuickOpenPath(relPath) &&
        !shouldExcludeQuickOpenRelPath(relPath, args.excludePathPrefixes) &&
        args.onPath &&
        !args.onPath(relPath)
      ) {
        stopRequested = true
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', handleStdoutData)
      child.stderr?.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      args.signal?.removeEventListener('abort', handleAbort)
      absorbPendingRipgrepSpawnError(child, {
        errorObserved: processErrorObserved,
        unavailableExitObserved
      })
    }
    const finish = (error?: Error): void => {
      if (done) {
        return
      }
      done = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const flushPendingBatch = async (): Promise<void> => {
      while (pendingBatch.length > 0 && !done) {
        const batch = pendingBatch.splice(0, batchSize)
        pendingBatchBytes -= batch.reduce((sum, path) => sum + Buffer.byteLength(path, 'utf8'), 0)
        if (args.onPathBatch && !(await args.onPathBatch(batch))) {
          stopRequested = true
          killSpawnedRipgrepProcess(child)
          finish()
          return
        }
      }
    }
    const startBatchFlush = (): void => {
      if (!args.onPathBatch || batchFlush || done) {
        return
      }
      child.stdout!.pause()
      const flush = flushPendingBatch()
      batchFlush = flush
      void flush
        .catch((error: unknown) => {
          killSpawnedRipgrepProcess(child)
          finish(toScanError(error))
        })
        .finally(() => {
          if (batchFlush === flush) {
            batchFlush = null
          }
          if (!done && !stopRequested) {
            if (args.timeoutMilliseconds !== undefined) {
              armTimeout()
            }
            child.stdout!.resume()
          }
        })
    }
    const finishClosedScan = async (
      code: number | null,
      signal: NodeJS.Signals | null
    ): Promise<void> => {
      if (batchFlush) {
        await batchFlush
      }
      if (done) {
        return
      }
      // Why before the unavailable check: classifyNativeLauncherExit treats any code above 2 as a
      // broken install, and this code is 97 -- so checking second makes this branch dead.
      if (isRipgrepMissingCwdExit(code)) {
        pathAccumulator.clear()
        finish(ripgrepMissingCwdError(args.authorizedRootPath))
        return
      }
      if (
        isRipgrepUnavailableExit(child, code, signal, {
          classifyNativeLauncherExit: true
        })
      ) {
        unavailableExitObserved = true
        finish(new RipgrepUnavailableError())
        return
      }
      if (signal) {
        finish(new Error(`rg killed by ${signal}`))
        return
      }
      const trailingPath = pathAccumulator.finish()
      if (trailingPath) {
        processLine(trailingPath)
      }
      await flushPendingBatch()
      if (!done) {
        finish(
          code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)
            ? undefined
            : new Error(`rg exited with code ${code}`)
        )
      }
    }
    const handleStdoutData = (chunk: string): void => {
      const verdict = pathAccumulator.push(chunk, (path) => {
        processLine(path)
        return !stopRequested
      })
      if (verdict === 'stopped') {
        killSpawnedRipgrepProcess(child)
        finish()
      } else if (verdict === 'path-too-large') {
        killSpawnedRipgrepProcess(child)
        finish(new Error('Ripgrep returned a path beyond the bounded scan limit'))
      }
    }
    const handleStderrData = (): void => {
      /* drain */
    }
    const handleError = (error: NodeJS.ErrnoException): void => {
      processErrorObserved = true
      if (isTransientRipgrepSpawnError(error)) {
        finish(new RipgrepLaunchFailureError(`rg failed to start (${error.code})`))
        return
      }
      if (!isRipgrepUnavailableExit(child, null, null)) {
        finish(new Error(`rg failed to start${error.code ? ` (${error.code})` : ''}`))
        return
      }
      // Why the cwd check: spawn reports a missing cwd as ENOENT too, and blaming the binary
      // for it tells the user to reinstall Orca over a workspace that simply moved.
      // Why detach close first: a failed spawn emits error THEN close(code < 0), and close settles
      // synchronously, so this probe would otherwise race it on a sub-millisecond margin -- two
      // measurements disagreed on which wins. Detaching makes the verdict deterministic.
      child.off('close', handleClose)
      // Why catch: a failed probe must not strand the search; fall back to the prior verdict.
      void isRipgrepSpawnCwdUsable(args.authorizedRootPath)
        .catch(() => true)
        .then((usable) => {
          finish(
            usable ? new RipgrepUnavailableError() : ripgrepMissingCwdError(args.authorizedRootPath)
          )
        })
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      void finishClosedScan(code, signal).catch((error: unknown) => finish(toScanError(error)))
    }
    const handleAbort = (): void => {
      pathAccumulator.clear()
      pendingBatch.length = 0
      pendingBatchBytes = 0
      killSpawnedRipgrepProcess(child)
      finish(fileListingCancellationError(args.signal))
    }

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', handleStdoutData)
    child.stderr?.on('data', handleStderrData)
    child.once('error', handleError)
    child.once('close', handleClose)
    args.signal?.addEventListener('abort', handleAbort, { once: true })
    const armTimeout = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        pathAccumulator.clear()
        killSpawnedRipgrepProcess(child)
        finish(new Error('rg file-path search timed out'))
      }, timeoutMilliseconds)
    }
    armTimeout()
    if (args.signal?.aborted) {
      handleAbort()
    }
  })
}

function toScanError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Path batch consumer failed')
}

function getOutputMode(rawLine: string, translatedLine: string, rootPath: string): RgOutputMode {
  return translatedLine !== rawLine ||
    rawLine.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(rawLine) ||
    rawLine.startsWith('\\\\')
    ? { kind: 'absolute', rootPath }
    : { kind: 'cwd-relative' }
}
