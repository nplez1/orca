import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { WorkspaceReviewSelection } from '../use-workspace-review-selection'
import { makeWorkspaceReviewSelection } from '../workspace-review-selection.test-fixture'
import { resolveChecksPanelShownReview } from './shown-review'

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 12,
    title: 'Add the thing',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/12',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function makeBranchPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Add the thing',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/12',
    checksStatus: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function makeSelection(
  overrides: Partial<WorkspaceReviewSelection> = {}
): WorkspaceReviewSelection {
  return makeWorkspaceReviewSelection(overrides)
}

const BRANCH_PR = makeBranchPR()
const WORKSPACE_REVIEW = makeReview()

function resolve(
  selection: WorkspaceReviewSelection,
  options: { linkedGitLabMR?: number | null; branchPR?: PRInfo | null } = {}
) {
  return resolveChecksPanelShownReview({
    branchPR: options.branchPR === undefined ? BRANCH_PR : options.branchPR,
    linkedGitLabMR: options.linkedGitLabMR ?? null,
    selection,
    workspaceReview: WORKSPACE_REVIEW
  })
}

describe('resolveChecksPanelShownReview', () => {
  it('keeps the branch review and its PR while nothing is picked', () => {
    const shown = resolve(makeSelection())

    expect(shown.activeReview).toBe(WORKSPACE_REVIEW)
    expect(shown.pr).toBe(BRANCH_PR)
    expect(shown.showsPickedReview).toBe(false)
    expect(shown.isGitLabReviewContext).toBe(false)
  })

  it('shows a picked GitHub review and maps it onto the PR shape the reads key on', () => {
    const picked = makeReview({
      number: 9,
      title: 'Parent change',
      headSha: 'picked-head',
      githubRepository: { owner: 'acme', repo: 'orca' }
    })
    const shown = resolve(
      makeSelection({
        isWorkspaceReview: false,
        selectedReview: picked
      })
    )

    expect(shown.activeReview).toBe(picked)
    expect(shown.showsPickedReview).toBe(true)
    expect(shown.pr).toMatchObject({
      number: 9,
      title: 'Parent change',
      headSha: 'picked-head',
      prRepo: { owner: 'acme', repo: 'orca' }
    })
  })

  it('shows a picked GitLab review and reads the GitLab context, not the branch PR', () => {
    const picked = makeReview({ provider: 'gitlab', number: 7, url: 'https://gitlab/x/7' })
    const shown = resolve(makeSelection({ isWorkspaceReview: false, selectedReview: picked }))

    expect(shown.activeReview).toBe(picked)
    expect(shown.activeGitLabReview).toBe(picked)
    expect(shown.isGitLabReviewContext).toBe(true)
    // Why null: an MR number is not a GitHub PR number, so nothing may fetch GitHub checks with it.
    expect(shown.pr).toBeNull()
  })

  it('keeps the workspace review for a pick this pane cannot render', () => {
    const picked = makeReview({ provider: 'bitbucket', number: 5, url: 'https://bitbucket/x/5' })
    const shown = resolve(makeSelection({ isWorkspaceReview: false, selectedReview: picked }))

    expect(shown.activeReview).toBe(WORKSPACE_REVIEW)
    expect(shown.pr).toBe(BRANCH_PR)
    expect(shown.showsPickedReview).toBe(false)
  })

  it('does not read a picked GitHub review as a GitLab context just because a slot holds an MR', () => {
    const picked = makeReview({ number: 9 })
    const shown = resolve(makeSelection({ isWorkspaceReview: false, selectedReview: picked }), {
      linkedGitLabMR: 7
    })

    expect(shown.isGitLabReviewContext).toBe(false)
  })

  it('reads the workspace review as a GitLab context when its own slot holds an MR', () => {
    const shown = resolve(makeSelection(), { linkedGitLabMR: 7 })

    expect(shown.isGitLabReviewContext).toBe(true)
  })
})
