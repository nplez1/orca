import { ghExecFileAsync } from '../../gh-utils'
import type { OwnerRepo, ghRepoExecOptions } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import {
  isNoPullRequestError,
  isNotFoundGhError,
  shouldStopAfterExactLookupError
} from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  mapRestPullRequest,
  normalizePullRequestLookupData,
  type PullRequestLookupData,
  type RestPullRequest
} from './pull-request-lookup-data'
import { hydratePullRequestLookupData } from './pull-request-lookup-hydration'
import { isGitObjectId, isUsableRestStackMetadata } from './rest-stack-metadata-validation'
export async function getRestPRByNumber(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  options: { requireUsableStackMetadata?: boolean } = {}
): Promise<PullRequestLookupData> {
  const { stdout } = await ghExecFileAsync(
    ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
    { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
  )
  const parsed = JSON.parse(stdout) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid response shape')
  }
  const restData = parsed as RestPullRequest
  const mapped = mapRestPullRequest(restData)
  if (
    options.requireUsableStackMetadata &&
    restData.stack !== undefined &&
    restData.stack !== null
  ) {
    // Why: GitHub omits stack for ordinary PRs; only unusable non-null metadata is unsafe.
    if (!isUsableRestStackMetadata(restData.stack) || !mapped.stack) {
      throw new Error('malformed stack')
    }
    if (!isGitObjectId(restData.head?.sha)) {
      throw new Error('missing head SHA')
    }
  }
  return mapped
}

export async function getPRByNumber(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  executionScope: string,
  knownPullRequestData?: PullRequestLookupData | null
): Promise<PullRequestLookupData | null> {
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'view',
        String(number),
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--json',
        PR_LOOKUP_JSON_FIELDS
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    const exactData = JSON.parse(stdout) as PullRequestLookupData
    return hydratePullRequestLookupData(
      ownerRepo,
      {
        ...knownPullRequestData,
        ...exactData,
        ...(knownPullRequestData?.stack ? { stack: knownPullRequestData.stack } : {})
      },
      ghOptions,
      executionScope
    )
  } catch (err) {
    // Why: deleted/edited linked PR metadata falls back to branch discovery; quota/auth/network failures get one cheaper REST exact lookup.
    if (isNotFoundGhError(err)) {
      return null
    }
    try {
      const restData =
        knownPullRequestData === undefined
          ? await getRestPRByNumber(ownerRepo, number, ghOptions)
          : knownPullRequestData
      return restData
        ? hydratePullRequestLookupData(ownerRepo, restData, ghOptions, executionScope)
        : null
    } catch (restErr) {
      if (isNotFoundGhError(restErr)) {
        return null
      }
      if (!shouldStopAfterExactLookupError(restErr)) {
        return null
      }
      throw restErr
    }
  }
}

export async function lookupPRByNumber(args: {
  candidates: OwnerRepo[]
  number: number
  ghOptions: ReturnType<typeof ghRepoExecOptions>
  executionScope: string
  /**
   * Why: a PR number is only unique inside one repo. A fork and the upstream it was forked from
   * number independently, so both can hold a PR with this number — and the upstream one is
   * unrelated. This worktree's own head ref tells the two apart, so prefer the candidate whose PR
   * carries it instead of trusting probe order.
   */
  preferHeadRefName?: string | null
}): Promise<{ data: PullRequestLookupData | null; dataRepo: OwnerRepo | null }> {
  let mismatched: { data: PullRequestLookupData; dataRepo: OwnerRepo } | null = null
  for (const candidate of args.candidates) {
    try {
      const linkedData = await getPRByNumber(
        candidate,
        args.number,
        args.ghOptions,
        args.executionScope
      )
      if (!linkedData) {
        continue
      }
      if (!args.preferHeadRefName || linkedData.headRefName === args.preferHeadRefName) {
        return { data: linkedData, dataRepo: candidate }
      }
      // Why: still the answer when no candidate holds a PR for this head ref — a worktree created
      // from a PR keeps a local branch that differs from the PR's, and its number stays authoritative.
      mismatched ??= { data: linkedData, dataRepo: candidate }
    } catch (err) {
      if (shouldStopAfterExactLookupError(err)) {
        throw err
      }
      // Candidate probing is best-effort; another repo may own the PR.
    }
  }

  if (mismatched) {
    return mismatched
  }

  if (args.candidates.length > 0) {
    return { data: null, dataRepo: null }
  }

  try {
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(args.number), '--json', PR_LOOKUP_JSON_FIELDS],
      args.ghOptions
    )
    return {
      data: normalizePullRequestLookupData(JSON.parse(stdout) as PullRequestLookupData),
      dataRepo: null
    }
  } catch (err) {
    if (isNoPullRequestError(err)) {
      // Why: stale cached fallback numbers shouldn't error every poll when the PR was deleted or belongs to another repo.
      return { data: null, dataRepo: null }
    }
    throw err
  }
}
