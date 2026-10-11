import { parseGitHubReviewState, type PRComment } from '../../../../shared/github/comment-types'
import { isReportableReviewSubmission } from '../../../../shared/pr-review-verdicts'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mapGraphQLReactionGroups, type GitHubGraphQLReactionGroup } from '../../comment-reactions'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { REVIEW_THREADS_QUERY } from './pr-review-threads-query'
/**
 * Get all comments on a PR — both top-level conversation comments and inline
 * review comments (including suggestions). Uses GraphQL for review threads
 * to get resolution status, REST for issue-level comments.
 */
export async function getPRComments(
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
  if (ownerRepo) {
    await assertRateLimitBudget('core', ownerRepo, ghOptions)
  }
  await acquire()
  try {
    if (ownerRepo) {
      // Why: --cache 60s saves rate-limit budget on normal loads; explicit refresh skips it for fresh data.
      const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
      const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`

      // Why: allSettled so one failing endpoint doesn't blank out all comments; failed sources contribute zero.
      const reviewThreadsGuard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
      let reviewThreadsFetch: Promise<{ stdout: string; stderr: string } | null>
      if (reviewThreadsGuard.blocked) {
        reviewThreadsFetch = Promise.resolve(null)
      } else {
        noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
        reviewThreadsFetch = ghExecFileAsync(
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
      }
      const [issueResult, threadsResult, reviewsResult] = await Promise.allSettled([
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/issues/${prNumber}/comments?per_page=100`],
          ghOptions
        ),
        reviewThreadsFetch,
        // Why: review summaries (approve/request-changes/general) live under pulls/{n}/reviews, not issue comments or threads.
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/pulls/${prNumber}/reviews?per_page=100`],
          ghOptions
        )
      ])
      noteRepositoryRateLimitSpend(ownerRepo, 'core', 2, ghOptions)

      // Parse issue comments (REST)
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        created_at: string
        html_url: string
      }
      let issueComments: PRComment[] = []
      if (issueResult.status === 'fulfilled') {
        issueComments = (JSON.parse(issueResult.value.stdout) as RESTComment[]).map(
          (c): PRComment => ({
            id: c.id,
            author: c.user?.login ?? 'ghost',
            authorAvatarUrl: c.user?.avatar_url ?? '',
            body: c.body ?? '',
            createdAt: c.created_at,
            url: c.html_url,
            isBot: c.user?.type === 'Bot'
          })
        )
      } else {
        console.warn('Failed to fetch issue comments:', issueResult.reason)
      }

      // Parse review threads (GraphQL)
      type GQLThread = {
        id: string
        isResolved: boolean
        line: number | null
        startLine: number | null
        originalLine: number | null
        originalStartLine: number | null
        comments: {
          nodes: {
            id: string
            databaseId: number
            author: { __typename?: string; login: string; avatarUrl: string } | null
            body: string
            createdAt: string
            url: string
            path: string
            reactionGroups?: GitHubGraphQLReactionGroup[] | null
          }[]
        }
      }
      type GQLIssueComment = {
        id: string
        databaseId: number
        author: { __typename?: string; login: string; avatarUrl: string } | null
        body: string
        /** Present on `reviews` nodes only — a review submission's verdict, GraphQL-only here. */
        state?: string | null
        createdAt: string
        url: string
        reactionGroups?: GitHubGraphQLReactionGroup[] | null
      }
      let graphQLReviewSummaries: PRComment[] | undefined
      const reviewComments: PRComment[] = []
      if (threadsResult.status === 'fulfilled' && threadsResult.value) {
        const threadsData = JSON.parse(threadsResult.value.stdout) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: { nodes?: GQLThread[] | null } | null
                comments?: { nodes?: GQLIssueComment[] | null } | null
                reviews?: { nodes?: GQLIssueComment[] | null } | null
              } | null
            } | null
          } | null
        }
        // Why: graphql can exit 0 with data.repository null plus an errors array (scopes, field-level denial);
        // dereferencing it would throw and drop the REST halves fetched alongside it.
        const pullRequest = threadsData.data?.repository?.pullRequest
        if (!pullRequest) {
          console.warn('Review threads response missing pullRequest; keeping REST results')
        }
        const graphQLIssueComments = (pullRequest?.comments?.nodes ?? []).map((c): PRComment => ({
          id: c.databaseId,
          author: c.author?.login ?? 'ghost',
          authorAvatarUrl: c.author?.avatarUrl ?? '',
          body: c.body ?? '',
          createdAt: c.createdAt,
          url: c.url,
          isBot: c.author?.__typename === 'Bot',
          reactionSubjectId: c.id,
          reactions: mapGraphQLReactionGroups(c.reactionGroups)
        }))
        if (graphQLIssueComments.length > 0) {
          issueComments = graphQLIssueComments
        }
        // Why: a verdict is the single most important event on a PR, so a review survives here even
        // with an empty body — but only for a caller that renders verdicts, and only when it
        // decides something (a bodyless `COMMENTED` review is how GitHub submits inline comments).
        // A pending review has no numeric id, so it cannot be anchored, keyed, or reacted to.
        // Leaving this undefined when the payload is incomplete keeps the REST review summaries in use.
        graphQLReviewSummaries = pullRequest
          ? (pullRequest.reviews?.nodes ?? []).reduce<PRComment[]>((reviews, review) => {
              const body = review.body ?? ''
              const reviewState = parseGitHubReviewState(review.state)
              const reportable = options?.includeReviewVerdicts
                ? isReportableReviewSubmission(body, reviewState)
                : body.trim().length > 0
              if (!review.databaseId || !reportable) {
                return reviews
              }
              reviews.push({
                id: review.databaseId,
                author: review.author?.login ?? 'ghost',
                authorAvatarUrl: review.author?.avatarUrl ?? '',
                body,
                createdAt: review.createdAt,
                url: review.url,
                isBot: review.author?.__typename === 'Bot',
                reviewState,
                reactionSubjectId: review.id,
                reactions: mapGraphQLReactionGroups(review.reactionGroups)
              })
              return reviews
            }, [])
          : undefined

        const threads = pullRequest?.reviewThreads?.nodes ?? []
        for (const thread of threads) {
          for (const c of thread.comments.nodes) {
            reviewComments.push({
              id: c.databaseId,
              author: c.author?.login ?? 'ghost',
              authorAvatarUrl: c.author?.avatarUrl ?? '',
              body: c.body ?? '',
              createdAt: c.createdAt,
              url: c.url,
              isBot: c.author?.__typename === 'Bot',
              reactionSubjectId: c.id,
              reactions: mapGraphQLReactionGroups(c.reactionGroups),
              path: c.path,
              threadId: thread.id,
              isResolved: thread.isResolved,
              isOutdated: thread.line == null,
              // Why: GitHub nulls line/startLine when the commented code is outdated (e.g. force-push); originalLine preserves the original numbers.
              line: thread.line ?? thread.originalLine ?? undefined,
              startLine: thread.startLine ?? thread.originalStartLine ?? undefined
            })
          }
        }
      } else {
        if (threadsResult.status === 'rejected') {
          console.warn('Failed to fetch review threads:', threadsResult.reason)
        }
      }

      // Review summaries (REST) — the fallback when GraphQL did not answer. Empty-body reviews are
      // kept for the same reason as above; the renderer decides what reads as a comment.
      type RESTReview = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        state: string
        submitted_at: string
        html_url: string
      }
      let reviewSummaries: PRComment[] = []
      if (graphQLReviewSummaries) {
        reviewSummaries = graphQLReviewSummaries
      } else if (reviewsResult.status === 'fulfilled') {
        reviewSummaries = (JSON.parse(reviewsResult.value.stdout) as RESTReview[])
          .filter((r) => r.id != null)
          .reduce<PRComment[]>((reviews, r) => {
            const body = r.body ?? ''
            const reviewState = parseGitHubReviewState(r.state)
            // Why: the same keep-rule as the GraphQL path, so the fallback cannot disagree with it.
            const reportable = options?.includeReviewVerdicts
              ? isReportableReviewSubmission(body, reviewState)
              : body.trim().length > 0
            if (!reportable) {
              return reviews
            }
            reviews.push({
              id: r.id,
              author: r.user?.login ?? 'ghost',
              authorAvatarUrl: r.user?.avatar_url ?? '',
              body,
              createdAt: r.submitted_at,
              url: r.html_url,
              isBot: r.user?.type === 'Bot',
              reviewState
            })
            return reviews
          }, [])
      } else {
        console.warn('Failed to fetch review summaries:', reviewsResult.reason)
      }

      const all = [...issueComments, ...reviewComments, ...reviewSummaries]
      all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return all
    }

    // Fallback: non-GitHub remote — use gh pr view (only returns issue-level comments)
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
    console.warn('getPRComments failed:', err)
    return []
  } finally {
    release()
  }
}
