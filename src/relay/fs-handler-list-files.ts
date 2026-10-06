import { quickOpenListingPathFilter } from '../shared/quick-open-listing-path-filter'
import { retainRelayFileListingPath } from './fs-file-listing-paths'
import { FileInventoryBudget } from '../shared/file-inventory-budget'
import { runRelayFileListingPasses, retryRelayFileListingPass } from './fs-list-files-passes'
import { RipgrepFilenameDecoder } from '../shared/ripgrep-filename-decoder'
/**
 * Ripgrep-based file listing for Quick Open.
 * Why a full rewrite vs. the older execFile+maxBuffer version: on a home-dir
 * worktree over SSH, rg descended into every dotfile cache, hit the timeout,
 * and silently resolved with a partial list — Quick Open then showed "No
 * matching files" even though the file existed on disk. This implementation:
 *   - streams via spawn (no maxBuffer failure mode)
 *   - prunes traversal at rg level using the shared blocklist globs
 *   - includes gitignored files, preserving primary-first order for bounded listings
 *   - honors excludePathPrefixes for nested linked worktrees
 *   - rejects (not resolves) on timeout / spawn error / signal exit so
 *     the UI shows a load error instead of a false-empty list
 *   - treats rg exit code 2 with parseable stdout as success (permission
 *     denied on a single subdir is expected on home-dir roots)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileListingCancellationError } from '../shared/file-listing-cancellation'
import { buildRgArgsForQuickOpen } from '../shared/quick-open-filter'
import {
  absorbPendingRipgrepSpawnError,
  classifyRipgrepLaunchFailure,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  RipgrepLaunchFailureError,
  ripgrepMissingCwdError,
  RipgrepUnavailableError
} from '../shared/ripgrep-process-availability'
import { hasDotfileAncestry } from '../shared/workspace-path-catalog'
import type { PathSearchMatcher, QuickOpenPathRanker } from '../shared/quick-open-path-search'
import { createQuickOpenListMatcher } from './quick-open-list-query-pass'
import type { QuickOpenListQueryOptions } from './quick-open-list-query-pass'
import { buildRelayCommandEnv } from './relay-command-env'
import {
  pathRipgrepCommand,
  resolveRelayRipgrepCommand,
  retryRipgrepOnPathAfterLaunchFailure
} from './relay-bundled-ripgrep'

export const LIST_FILES_TIMEOUT_MS = 25_000

export function listFilesWithRg(
  rootPath: string,
  excludePathPrefixes: readonly string[] = [],
  options: QuickOpenListQueryOptions & {
    signal?: AbortSignal
    maxResults?: number
    candidatePaths?: string[]
    includeIgnored?: boolean
    followSymlinks?: boolean
  } = {}
): Promise<string[]> {
  const { signal, maxResults, searchQuery, searchMode, includeIgnoredFiles } = options
  // Upstream's recent-files allowlist plus the fork's name-filter dotfile scope: a rejected line is consumed.
  const listablePath = quickOpenListingPathFilter(excludePathPrefixes, options.candidatePaths)
  const includePath = (path: string): boolean =>
    listablePath(path) &&
    !(searchMode === 'name-filter' && options.includeDotfiles === false && hasDotfileAncestry(path))
  // The fork's `includeIgnoredFiles` and upstream's `includeIgnored` both skip the ignored pass.
  const skipIgnoredPass = options.includeIgnored === false || includeIgnoredFiles === false
  const listingOptions = skipIgnoredPass ? { ...options, includeIgnored: false } : options
  if (signal?.aborted) {
    return Promise.reject(fileListingCancellationError(signal))
  }
  return new Promise((resolve, reject) => {
    const inventoryBudget =
      maxResults === undefined && searchQuery === undefined ? new FileInventoryBudget() : null
    const files = new Set<string>()
    const retention = { files, budget: inventoryBudget, includePath }
    let rankedPaths: string[] | null = null
    let done = false
    type ListingChild = {
      child: ChildProcess
      isDone: () => boolean
      reject: (error: Error) => void
    }
    const children: ListingChild[] = []

    const { primary, ignoredPass } = buildRgArgsForQuickOpen({
      // Why: rg only applies root-relative exclude globs as traversal pruning
      // when the search target is relative to cwd. Absolute targets still
      // emit root-relative-looking paths for filters, but they do not prune.
      searchRoot: '.',
      followSymlinks: options.followSymlinks,
      excludePathPrefixes,
      forceSlashSeparator: true
    })

    const processLine = (rawLine: string, attemptRanker: PathSearchMatcher | null): boolean => {
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retainRelayFileListingPath only calls `consider`, which every PathSearchMatcher implements.
        const ranker = attemptRanker as QuickOpenPathRanker | null
        const included = retainRelayFileListingPath(rawLine, ranker, retention)
        if (maxResults !== undefined && files.size >= maxResults) {
          finishAtLimit()
        }
        return included
      } catch (error) {
        settleListing()
        killSurvivors('File inventory capacity exceeded')
        files.clear()
        reject(error)
        return true
      }
    }

    const runPassOnce = (args: string[]): Promise<void> =>
      new Promise((passResolve, passReject) => {
        // A completed pass may queue its continuation before cancellation settles the request.
        if (done || signal?.aborted) {
          return passResolve()
        }
        const attemptMatcher = createQuickOpenListMatcher({ searchQuery, searchMode, maxResults })
        const filenameDecoder = new RipgrepFilenameDecoder((error) => {
          killSpawnedRipgrepProcess(child)
          rejectPass(error)
        })
        let passBuf = ''
        let passDone = false
        let passFileCount = 0
        let processErrorObserved = false
        let unavailableExitObserved = false
        let launchFailureCheck: Promise<void> | null = null
        // Suppress permission noise; cwd anchors root-relative exclusion globs.
        const command = resolveRelayRipgrepCommand()
        // Why not spawn a bare name when this is null: on Windows CreateProcessW searches the
        // spawn cwd -- the user's repo -- before PATH. "No rg here" is what the chain handles.
        if (command === null) {
          throw new RipgrepUnavailableError()
        }
        const env = buildRelayCommandEnv()
        let child: ChildProcess
        try {
          child = spawn(command, ['--no-messages', ...args], {
            cwd: rootPath,
            env,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
          })
        } catch (error) {
          throw isTransientRipgrepSpawnError(error)
            ? new RipgrepLaunchFailureError(
                `rg failed to start (${(error as NodeJS.ErrnoException).code})`
              )
            : error
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          child.stdout?.off('data', handleStdoutData)
          child.off('error', handleError)
          child.off('close', handleClose)
          absorbPendingRipgrepSpawnError(child, {
            errorObserved: processErrorObserved,
            unavailableExitObserved
          })
        }
        const rejectPass = (error: unknown): void => {
          if (passDone) {
            return
          }
          passDone = true
          passBuf = ''
          cleanup()
          passReject(error instanceof Error ? error : new Error(String(error)))
        }
        const resolvePass = (complete = true): void => {
          if (passDone) {
            return
          }
          passDone = true
          cleanup()
          const result = attemptMatcher?.result()
          if (result) {
            rankedPaths = result.paths
            options.onSearchResult?.(result, complete)
          }
          passResolve()
        }
        const rejectLaunchFailure = (error: Error): void => {
          if (launchFailureCheck) {
            return
          }
          launchFailureCheck = retryRipgrepOnPathAfterLaunchFailure(command, rootPath, error)
            .then(async (retryOnPath) => {
              if (passDone || done) {
                return
              }
              if (retryOnPath) {
                // Why: runPass retries a launch failure once, and the retry resolves to PATH rg.
                rejectPass(new RipgrepLaunchFailureError('bundled rg failed to start'))
                return
              }
              // Why distinguish: RipgrepUnavailableError is what engages the git/readdir chain,
              // and that chain cannot help when the root itself is gone.
              rejectPass(
                (await classifyRipgrepLaunchFailure(
                  rootPath,
                  [command, pathRipgrepCommand()],
                  env,
                  signal
                )) === 'cwd-unreachable'
                  ? ripgrepMissingCwdError(rootPath)
                  : new RipgrepUnavailableError()
              )
            })
            .catch(rejectPass)
        }
        children.push({ child, isDone: () => passDone, reject: rejectPass })

        const timer = setTimeout(() => {
          // Discard residual buffer on abnormal exit — a truncated byte
          // sequence could look like a valid path.
          killSpawnedRipgrepProcess(child)
          rejectPass(new Error('rg list timed out'))
        }, LIST_FILES_TIMEOUT_MS)

        function handleStdoutData(chunk: Buffer | string): void {
          const decoded = filenameDecoder.decode(chunk)
          if (decoded === null) {
            return
          }
          passBuf += decoded
          let start = 0
          let idx = passBuf.indexOf('\0', start)
          while (idx !== -1) {
            if (processLine(passBuf.substring(start, idx), attemptMatcher)) {
              passFileCount++
            }
            if (done) {
              return
            }
            start = idx + 1
            idx = passBuf.indexOf('\0', start)
          }
          passBuf = start < passBuf.length ? passBuf.substring(start) : ''
        }
        function handleError(err: NodeJS.ErrnoException): void {
          processErrorObserved = true
          if (isTransientRipgrepSpawnError(err)) {
            rejectPass(new RipgrepLaunchFailureError(`rg failed to start (${err.code})`))
            return
          }
          if (isRipgrepUnavailableExit(child, null, null)) {
            passBuf = ''
            rejectLaunchFailure(err)
            return
          }
          rejectPass(err)
        }
        function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
          if (passDone) {
            return
          }
          if (
            isRipgrepUnavailableExit(child, code, signal, {
              classifyNativeLauncherExit: true
            })
          ) {
            unavailableExitObserved = true
            passBuf = ''
            rejectLaunchFailure(new Error(`rg exited with code ${code}`))
            return
          }
          // Why signal != null is a failure: the only way spawn gets a signal
          // is if the process was killed (timeout, OOM, external SIGKILL).
          // Trusting its stdout could surface a truncated list as a success.
          if (signal) {
            rejectPass(new Error(`rg killed by ${signal}`))
            return
          }
          if (!filenameDecoder.finish()) {
            return
          }
          // Flush residual line only on clean exit.
          if (passBuf && processLine(passBuf, attemptMatcher)) {
            passFileCount++
          }
          // exit 0 = matches found, 1 = no files (still success for --files).
          // exit 2 is documented as "a subdirectory could not be searched"
          // (e.g. EACCES on .ssh), but rg also returns 2 for fatal errors
          // (bad flag, invalid glob). Only trust exit 2 when rg emitted at
          // least one parseable path — otherwise treat it as a real failure.
          if (code === 0 || code === 1) {
            resolvePass()
          } else if (code === 2 && passFileCount > 0) {
            resolvePass(searchMode !== 'name-filter')
          } else {
            rejectPass(new Error(`rg exited with code ${code}`))
          }
        }

        child.stdout?.on('data', handleStdoutData)
        child.once('error', handleError)
        child.once('close', handleClose)
      })

    const isCanceled = (): boolean => Boolean(signal?.aborted || done)
    const runPass = (args: string[]): Promise<void> =>
      retryRelayFileListingPass(() => runPassOnce(args), isCanceled)

    const killSurvivors = (reason: string): void => {
      // Cancellation or a reached budget must stop any admitted scan or retry.
      for (const entry of children.filter((child) => !child.isDone())) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          killSpawnedRipgrepProcess(entry.child)
        }
        entry.reject(new Error(reason))
      }
    }

    /** First caller wins: settles `done` and unhooks the abort listener exactly once. */
    const settleListing = (): boolean => {
      if (done) {
        return false
      }
      done = true
      signal?.removeEventListener('abort', onAbort)
      return true
    }

    function finishAtLimit(): void {
      if (settleListing()) {
        killSurvivors('rg list reached bounded result limit')
        resolve(Array.from(files).slice(0, maxResults))
      }
    }

    // Why: a cancelled scan (workspace switch, superseded request) must stop
    // its rg children immediately instead of letting them walk the tree to
    // completion and flood the relay with stdout it will only discard.
    const onAbort = (): void => {
      if (settleListing()) {
        killSurvivors('rg list cancelled')
        reject(fileListingCancellationError(signal))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    runRelayFileListingPasses(listingOptions, primary, ignoredPass, runPass, () => files.size)
      .then(() => {
        if (settleListing()) {
          resolve(rankedPaths ?? Array.from(files))
        }
      })
      .catch((err) => {
        if (settleListing()) {
          killSurvivors('rg list canceled after failure')
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
  })
}
