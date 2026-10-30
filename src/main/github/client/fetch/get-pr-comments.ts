import type { PRComment } from '../../../../shared/github/comment-types'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/coalesced-probe'
import { extractExecError } from '../../../git/exec-error'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { REVIEW_THREADS_QUERY } from './pr-review-threads-query'
import { parsePRConversationResponse, parseRestPRComments } from './pr-conversation-response'
/** Combine conversation comments, review summaries and GraphQL threads with resolution metadata. */
async function readPRComments(
  repoPath: string,
  prNumber: number,
  options?: {
    noCache?: boolean
    prRepo?: GitHubApiRepository | null
    /**
     * Whether this caller renders review verdicts.
     *
     * Why opt-in: a review submitted with no comment is a verdict the Checks panel must show and an
     * empty card everywhere else — the PR page, the issue dialog and mobile all read this same
     * payload as comments. Only the Checks panel asks for the verdict-only entries; everyone else
     * keeps the pre-existing "must carry a body" rule, and a peer that predates the flag is
     * unaffected because the default is off.
     */
    includeReviewVerdicts?: boolean
  },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRComment[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    options?.prRepo,
    connectionId,
    localGitOptions
  )
  if (connectionId && !ownerRepo) {
    throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
  }
  await acquire()
  let restBudgetFailed = false
  try {
    if (ownerRepo) {
      // Explicit refresh bypasses the polling cache.
      const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
      const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`

      // Retain successful comment sources when another endpoint fails.
      const reviewThreadsGuard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
      let threadsResult: { stdout: string } | null = null
      if (reviewThreadsGuard.blocked) {
        threadsResult = null
      } else {
        noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
        try {
          threadsResult = await ghExecFileAsync(
            [
              'api',
              'graphql',
              '-f',
              `query=${REVIEW_THREADS_QUERY}`,
              '-f',
              `owner=${ownerRepo.owner}`,
              '-f',
              `repo=${ownerRepo.repo}`,
              '-F',
              `pr=${prNumber}`
            ],
            ghOptions
          )
        } catch (error) {
          // gh exits nonzero for partial GraphQL errors; keep the successful sources.
          const { stdout } = extractExecError(error)
          threadsResult = stdout ? { stdout } : null
          console.warn('Failed to fetch review threads:', error)
        }
      }

      let conversation: ReturnType<typeof parsePRConversationResponse> = { reviewComments: [] }
      if (threadsResult) {
        try {
          conversation = parsePRConversationResponse(threadsResult.stdout, {
            includeReviewVerdicts: options?.includeReviewVerdicts
          })
        } catch {
          console.warn('Invalid review threads response; falling back to REST')
        }
      }
      const { issueComments, reviewSummaries, reviewComments } = conversation

      const readRestSource = async (endpoint: string): Promise<PRComment[]> => {
        await assertRateLimitBudget('core', ownerRepo, ghOptions).catch((error: unknown) => {
          restBudgetFailed = true
          throw error
        })
        try {
          noteRepositoryRateLimitSpend(ownerRepo, 'core', 1, ghOptions)
          const { stdout } = await ghExecFileAsync(['api', ...cacheArgs, endpoint], ghOptions)
          return parseRestPRComments(stdout, endpoint.includes('/reviews?'), {
            includeReviewVerdicts: options?.includeReviewVerdicts
          })
        } catch (error) {
          console.warn('Failed to fetch PR conversation fallback:', error)
          return []
        }
      }
      const [issueResult, reviewsResult] = await Promise.all([
        issueComments === undefined
          ? readRestSource(`${base}/issues/${prNumber}/comments?per_page=100`)
          : null,
        reviewSummaries === undefined
          ? readRestSource(`${base}/pulls/${prNumber}/reviews?per_page=100`)
          : null
      ])
      const all = [
        ...(issueComments ?? issueResult ?? []),
        ...reviewComments,
        ...(reviewSummaries ?? reviewsResult ?? [])
      ]
      all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return all
    }

    // Legacy local fallback returns issue-level comments only.
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      ghOptions
    )
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const data = JSON.parse(stdout) as {
      comments: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
      }[]
    }
    return (data.comments ?? []).map((c, i) => ({
      id: i,
      author: c.author?.login ?? 'ghost',
      authorAvatarUrl: '',
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url ?? ''
    }))
  } catch (err) {
    if (restBudgetFailed) {
      throw err
    }
    console.warn('getPRComments failed:', err)
    return []
  } finally {
    release()
  }
}

const commentReads: CoalescedProbes<PRComment[]> = new Map()

export function getPRComments(
  repoPath: string,
  prNumber: number,
  options?: {
    noCache?: boolean
    prRepo?: GitHubApiRepository | null
    includeReviewVerdicts?: boolean
  },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRComment[]> {
  // Forced refreshes often follow a mutation, so they must not join a read that started before it.
  if (options?.noCache) {
    return readPRComments(repoPath, prNumber, options, connectionId, localGitOptions)
  }
  // Why the flag is in the key: the verdict filter changes what the fetch returns, so a Checks-panel
  // read and a PR-page read of the same PR must not join one fetch and inherit its filtering.
  const key = JSON.stringify([
    repoPath,
    prNumber,
    options?.prRepo ?? null,
    connectionId ?? null,
    githubReadExecutionScope(localGitOptions),
    options?.includeReviewVerdicts === true
  ])
  return runCoalescedProbe(commentReads, key, () =>
    readPRComments(repoPath, prNumber, options, connectionId, localGitOptions)
  )
}
