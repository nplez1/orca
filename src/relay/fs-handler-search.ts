import type { RequestContext } from './dispatcher'
import { searchWithGitGrep } from './fs-handler-git-fallback'
import { DEFAULT_MAX_RESULTS, searchWithRg } from './fs-handler-utils'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { expandTilde } from './context'

export async function searchRelayFiles(params: Record<string, unknown>, context?: RequestContext) {
  const query = params.query as string
  const rootPath = expandTilde(params.rootPath as string)
  const caseSensitive = params.caseSensitive as boolean | undefined
  const wholeWord = params.wholeWord as boolean | undefined
  const useRegex = params.useRegex as boolean | undefined
  const includePattern = params.includePattern as string | undefined
  const excludePattern = params.excludePattern as string | undefined
  const maxResults = Math.min(
    (params.maxResults as number) || DEFAULT_MAX_RESULTS,
    DEFAULT_MAX_RESULTS
  )

  const options = {
    caseSensitive,
    wholeWord,
    useRegex,
    includePattern,
    excludePattern,
    maxResults,
    signal: context?.signal
  }
  try {
    return await searchWithRg(rootPath, query, options)
  } catch (error) {
    if (!(error instanceof RipgrepUnavailableError)) {
      throw error
    }
    return searchWithGitGrep(rootPath, query, options)
  }
}
