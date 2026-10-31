import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { setGitHubPRResultCaches } from '@/store/github/pr-result-cache'
import { createTestStore, makePR } from '@/store/slices/github-slice-test-harness'
import { selectWorkspaceReviewState } from './checks-panel-review'

const HEAD = 'head-oid'

function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: HEAD,
    ...overrides
  }
}

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 42,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/42',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: HEAD,
    ...overrides
  }
}

type Scenario = {
  name: string
  prEntry?: { data: PRInfo | null }
  hostedEntry?: { data: HostedReviewInfo | null }
  head?: string
  linkedPR?: number | null
  suppressedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  expected: { state: HostedReviewInfo['state']; number: number } | null
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a merged PR outranks a hosted-review copy that still says open',
    prEntry: { data: makePRInfo({ state: 'merged' }) },
    hostedEntry: { data: makeReview({ state: 'open' }) },
    expected: { state: 'merged', number: 42 }
  },
  {
    name: 'a merged PR outranks a hosted-review miss for the branch',
    prEntry: { data: makePRInfo({ state: 'merged' }) },
    hostedEntry: { data: null },
    expected: { state: 'merged', number: 42 }
  },
  {
    name: 'an open PR outranks a hosted-review copy that says merged',
    prEntry: { data: makePRInfo({ state: 'open' }) },
    hostedEntry: { data: makeReview({ state: 'merged' }) },
    expected: { state: 'open', number: 42 }
  },
  {
    name: 'the hosted review stands in while the PR cache has no answer',
    hostedEntry: { data: makeReview({ state: 'open' }) },
    expected: { state: 'open', number: 42 }
  },
  {
    name: 'a PR cache answer of "no PR" outranks the hosted review',
    prEntry: { data: null },
    hostedEntry: { data: makeReview({ state: 'merged' }) },
    expected: null
  },
  {
    name: 'a merged PR the worktree head moved past is dropped from the PR cache',
    prEntry: { data: makePRInfo({ state: 'merged', headSha: 'older' }) },
    head: 'newer',
    expected: null
  },
  {
    name: 'a merged review the worktree head moved past is dropped from the hosted cache',
    hostedEntry: { data: makeReview({ state: 'merged', headSha: 'older' }) },
    head: 'newer',
    expected: null
  },
  {
    name: 'a merged review at a confirmed-contained head is kept',
    hostedEntry: {
      data: makeReview({ state: 'merged', headSha: 'final', confirmedContainedHeadOid: HEAD })
    },
    expected: { state: 'merged', number: 42 }
  },
  {
    name: 'a linked PR that does not match the branch answer is dropped',
    prEntry: { data: makePRInfo({ state: 'merged' }) },
    linkedPR: 43,
    expected: null
  },
  {
    name: 'a suppressed PR is dropped',
    prEntry: { data: makePRInfo({ state: 'merged' }) },
    suppressedGitHubPR: 42,
    expected: null
  },
  {
    name: 'a GitLab MR link keeps GitHub answers off the workspace',
    prEntry: { data: makePRInfo({ state: 'merged' }) },
    hostedEntry: { data: makeReview({ state: 'open' }) },
    linkedGitLabMR: 7,
    expected: null
  },
  {
    name: 'a GitLab review is shown from the hosted cache',
    hostedEntry: {
      data: makeReview({ provider: 'gitlab', number: 7, title: 'MR' })
    },
    linkedGitLabMR: 7,
    expected: { state: 'open', number: 7 }
  }
]

function selectFor(scenario: Scenario): ReturnType<typeof selectWorkspaceReviewState> {
  return selectWorkspaceReviewState({
    prEntry: scenario.prEntry,
    hostedEntry: scenario.hostedEntry,
    currentHeadOid: scenario.head ?? HEAD,
    linkedPR: scenario.linkedPR ?? null,
    suppressedGitHubPR: scenario.suppressedGitHubPR ?? null,
    linkedGitLabMR: scenario.linkedGitLabMR ?? null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null
  })
}

describe('selectWorkspaceReviewState', () => {
  it.each(SCENARIOS)('$name', (scenario) => {
    const review = selectFor(scenario)

    if (scenario.expected === null) {
      expect(review).toBeNull()
      return
    }

    expect(review).toMatchObject(scenario.expected)
  })
})

describe('workspace review state propagation', () => {
  it('moves the workspace state to the merged PR as soon as the PR result lands', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/parity'
    const prCacheKey = `${repoId}::${branch}`
    const hostedKey = getHostedReviewCacheKey(repoPath, branch, null, repoId, null, null, true)

    store.setState({
      prCache: { [prCacheKey]: { data: makePR({ state: 'open' }), fetchedAt: 100 } },
      // A hosted-review copy that still describes the pre-merge state.
      hostedReviewCache: { [hostedKey]: { data: makeReview({ state: 'open' }), fetchedAt: 100 } }
    })

    const readState = (): ReturnType<typeof selectWorkspaceReviewState> => {
      const state = store.getState()
      return selectWorkspaceReviewState({
        prEntry: state.prCache[prCacheKey],
        hostedEntry: state.hostedReviewCache[hostedKey],
        currentHeadOid: HEAD,
        linkedPR: null,
        suppressedGitHubPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    }

    expect(readState()).toMatchObject({ state: 'open' })

    // The write the Checks pane performs when its own refresh lands.
    store.setState(
      setGitHubPRResultCaches(store.getState(), {
        prCacheKey,
        repoPath,
        branch,
        settings: null,
        repoId,
        pr: makePR({ state: 'merged' }),
        fetchedAt: 200
      })
    )

    expect(readState()).toMatchObject({ state: 'merged' })
  })
})
