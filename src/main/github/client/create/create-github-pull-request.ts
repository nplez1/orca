import type { ExecutionHostId } from '../../../../shared/execution-host'
import { hostedReviewSshConnectionId } from '../../../source-control/hosted-review-execution-host'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult
} from '../../../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef,
  hostedReviewHeadRef
} from '../../../../shared/hosted-review-refs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ghExecFileAsync,
  acquire,
  release,
  ghRepoExecOptions,
  githubRepoContext
} from '../../gh-utils'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../../source-control/hosted-review-git-options'
import {
  getIssueGitHubApiRepository,
  getOriginGitHubApiRepository,
  githubHostExecOptions
} from '../../github-api-repository'
import { classifyCreatePRError, parseCreatePRPayload } from './create-pr-error-classification'
import { findOpenPRByHeadBase, readPullRequestTemplate } from './pull-request-template'
export async function createGitHubPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  // `gh` runs on this client whatever the host; only the git reads under it are routed.
  const connectionId = hostedReviewSshConnectionId(executionHostId)

  // Why: on a fork checkout the head branch lives on origin (your fork) while the
  // review belongs to the upstream parent, so `gh pr create` must POST to the
  // parent and owner-qualify the head (#7331). Targeting origin with a bare head
  // opened a review inside the fork instead — the base and the branch's own
  // history then diverge and the diff reads as a rewrite of the whole repo.
  const headOwnerRepo = await getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!headOwnerRepo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a GitHub remote.'
    }
  }
  // Same-repo checkouts (the common team case) never have an upstream, so this
  // resolves to the head repo and every argument below stays unchanged.
  const baseOwnerRepo =
    (await getIssueGitHubApiRepository(
      repoPath,
      connectionId,
      getHostedReviewLocalGitOptions(options)
    ).catch(() => null)) ?? headOwnerRepo
  // The runner host-qualifies --repo from options.host for GHES (#8312).
  const repoArg = `${baseOwnerRepo.owner}/${baseOwnerRepo.repo}`

  const base = normalizeHostedReviewBaseRef(input.base)
  const head = input.head ? normalizeHostedReviewHeadRef(input.head) || undefined : undefined
  const headRef = head ? hostedReviewHeadRef(baseOwnerRepo, headOwnerRepo, head) : undefined
  const title = input.title.trim()
  if (!base || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: base branch and title are required.'
    }
  }
  if (head && head.toLowerCase() === base.toLowerCase()) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: choose a different base branch before creating a pull request.'
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'orca-pr-body-'))
  await acquire()
  const bodyPath = join(tempDir, 'body.md')
  try {
    const body =
      input.useTemplate && !input.body?.trim()
        ? await readPullRequestTemplate(repoPath, connectionId)
        : (input.body ?? '')
    await writeFile(bodyPath, body, 'utf8')
    const createArgs = [
      'pr',
      'create',
      '--repo',
      repoArg,
      '--base',
      base,
      '--title',
      title,
      '--body-file',
      bodyPath
    ]
    if (headRef) {
      createArgs.push('--head', headRef)
    }
    if (input.draft) {
      createArgs.push('--draft')
    }
    try {
      const context = githubRepoContext(repoPath, connectionId)
      const { stdout } = await ghExecFileAsync(createArgs, {
        ...ghRepoExecOptions(context),
        ...(connectionId ? {} : getHostedReviewLocalGitOptions(options)),
        ...githubHostExecOptions(baseOwnerRepo),
        timeout: 60_000,
        idempotent: false
      })
      const created = parseCreatePRPayload(stdout)
      if (created) {
        return { ok: true, ...created }
      }
      const found = headRef
        ? await findOpenPRByHeadBase({
            repoPath,
            repo: baseOwnerRepo,
            head: headRef,
            base,
            connectionId,
            options
          }).catch(() => null)
        : null
      if (found) {
        return { ok: true, ...found }
      }
      return {
        ok: false,
        code: 'unknown_completion',
        error: 'PR creation may have completed. Refreshing branch review state...'
      }
    } catch (error) {
      const classified = classifyCreatePRError(error)
      if (
        !classified.ok &&
        (classified.code === 'already_exists' || classified.code === 'unknown_completion') &&
        headRef
      ) {
        const existing = await findOpenPRByHeadBase({
          repoPath,
          repo: baseOwnerRepo,
          head: headRef,
          base,
          connectionId,
          options
        }).catch(() => null)
        if (existing) {
          return {
            ok: false,
            code: 'already_exists',
            error: 'A pull request already exists for this branch.',
            existingReview: existing
          }
        }
      }
      return classified
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    release()
  }
}
