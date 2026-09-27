import type { IpcMainInvokeEvent } from 'electron'
import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../../shared/text-search'
import { SearchSubprocessLineAccumulator } from '../../../shared/search-subprocess-lines'
import { RipgrepSearchDiagnostics } from '../../../shared/ripgrep-search-diagnostics'
import {
  absorbPendingRipgrepSpawnError,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError
} from '../../../shared/ripgrep-process-availability'
import { toWindowsWslPath, parseWslPath } from '../../wsl'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { resolveDesktopAuthorizedPath } from '../local-file-access-resolution'
import { bundledRipgrepUnavailableError } from '../../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../../ripgrep/bundled-ripgrep-spawn'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** `fs:search` — owns the ripgrep process, its cancellation slot and its timeout. */
export async function handleFilesystemTextSearch(
  event: IpcMainInvokeEvent,
  args: SearchOptions & { connectionId?: string },
  context: FilesystemHandlerContext
): Promise<SearchResult> {
  const { store, activeTextSearches } = context

  if (args.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    return provider.search(args)
  }
  const rootPath = await resolveDesktopAuthorizedPath(args.rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(store, args.rootPath, rootPath)
  const maxResults = Math.max(
    1,
    Math.min(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
  )
  const searchKey = `${event.sender.id}:${rootPath}`
  const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? localGitOptions.wslDistro

  return new Promise<SearchResult>((resolvePromise, rejectPromise) => {
    const rgArgs = buildRgArgs(args.query, '.', args)
    // Why: kill the prior rg so it stops parsing thousands of matches on the main thread (the large-repo freeze) after the UI moved on.
    const previousChild = activeTextSearches.get(searchKey)
    if (previousChild) {
      killSpawnedRipgrepProcess(previousChild)
    }

    const acc = createAccumulator()
    const lines = new SearchSubprocessLineAccumulator()
    const diagnostics = new RipgrepSearchDiagnostics()
    let resolved = false
    let processErrorObserved = false
    let unavailableExitObserved = false
    let child: ReturnType<typeof spawnBundledRipgrep> | null = null
    let killTimeout: ReturnType<typeof setTimeout>

    const transformAbsPath = wslDistroForOutput
      ? (path: string): string | null =>
          path.includes('\\')
            ? null
            : path.startsWith('/')
              ? toWindowsWslPath(path, wslDistroForOutput)
              : path
      : undefined

    const finish = (result: SearchResult | PromiseLike<SearchResult>): void => {
      if (resolved) {
        return
      }
      resolved = true
      if (activeTextSearches.get(searchKey) === child) {
        activeTextSearches.delete(searchKey)
      }
      lines.clear()
      clearTimeout(killTimeout)
      // Why: child.kill() is advisory; detach our closures so repeated searches don't retain old scans if rg ignores it.
      child?.stdout?.off('data', handleStdoutData)
      child?.stderr?.off('data', handleStderrData)
      child?.off('error', handleError)
      child?.off('close', handleClose)
      if (child) {
        absorbPendingRipgrepSpawnError(child, {
          errorObserved: processErrorObserved,
          unavailableExitObserved
        })
      }
      resolvePromise(result)
    }
    const resolveOnce = (code = 0, signal: NodeJS.Signals | null = null): void => {
      const error = diagnostics.failure(code, signal, acc)
      finish(error ? Promise.reject(error) : finalize(acc))
    }
    const rejectUnavailable = (): void => finish(Promise.reject(bundledRipgrepUnavailableError()))
    const processLine = (line: string): void => {
      const verdict = ingestRgJsonLine(line, rootPath, acc, maxResults, transformAbsPath)
      if (verdict === 'stop' && child) {
        killSpawnedRipgrepProcess(child)
      }
    }

    // A synchronous spawn failure has no child to clean up.
    let nextChild: ReturnType<typeof spawnBundledRipgrep>
    try {
      nextChild = spawnBundledRipgrep(rgArgs, {
        cwd: rootPath,
        wslDistro: localGitOptions.wslDistro,
        wslDistroForOutput,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      void classifySynchronousRipgrepSpawnFailure(error, rootPath).then(
        rejectPromise,
        rejectPromise
      )
      return
    }
    child = nextChild
    activeTextSearches.set(searchKey, nextChild)

    const handleStdoutData = (chunk: string): void => {
      if (!lines.push(chunk, processLine)) {
        acc.truncated = true
        if (child) {
          killSpawnedRipgrepProcess(child)
        }
        resolveOnce()
      }
    }
    const handleStderrData = (chunk: Buffer): void => {
      diagnostics.append(chunk)
    }
    const handleError = (error: NodeJS.ErrnoException): void => {
      processErrorObserved = true
      // Why: fd/process pressure is not a broken install; say so instead of blaming the bundled binary.
      if (isTransientRipgrepSpawnError(error)) {
        finish(Promise.reject(new Error(`rg could not start (${error.code}); try again`)))
        return
      }
      if (child && isRipgrepUnavailableExit(child, null, null)) {
        // Distinguish a missing workspace from a missing binary before close can settle.
        child.off('close', handleClose)
        void isRipgrepSpawnCwdUsable(rootPath)
          .catch(() => true)
          .then((usable) => {
            // A late rejected promise must not escape after close settles the search.
            if (resolved) {
              return
            }
            finish(
              Promise.reject(
                usable ? bundledRipgrepUnavailableError() : ripgrepMissingCwdError(rootPath)
              )
            )
          })
        return
      }
      finish(Promise.reject(error))
      if (child) {
        killSpawnedRipgrepProcess(child)
      }
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      // Why first: this code is above rg's own 0/1/2, so the unavailable check would otherwise
      // read an unreachable workspace as a broken install and tell the user to reinstall Orca.
      if (isRipgrepMissingCwdExit(code)) {
        finish(Promise.reject(ripgrepMissingCwdError(rootPath)))
        return
      }
      if (
        child &&
        isRipgrepUnavailableExit(child, code, signal, {
          classifyNativeLauncherExit: true
        })
      ) {
        unavailableExitObserved = true
        rejectUnavailable()
        return
      }
      const tail = !signal && (code === 0 || code === 1) ? lines.finish() : null
      if (tail !== null) {
        processLine(tail)
      }
      resolveOnce(code ?? -1, signal)
    }

    nextChild.stdout?.setEncoding('utf-8')
    nextChild.stdout?.on('data', handleStdoutData)
    nextChild.stderr?.on('data', handleStderrData)
    nextChild.once('error', handleError)
    nextChild.once('close', handleClose)

    // Why: timeout kills the child mid-scan; mark truncated so the UI shows incomplete results.
    killTimeout = setTimeout(() => {
      acc.truncated = true
      if (child) {
        killSpawnedRipgrepProcess(child)
      }
      resolveOnce()
    }, SEARCH_TIMEOUT_MS)
  })
}
