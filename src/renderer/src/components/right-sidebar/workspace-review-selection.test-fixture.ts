import type { WorkspaceReviewSelection } from './use-workspace-review-selection'
import type { WorkspaceReviewSelectionEntry } from './workspace-review-selection'

/** A workspace that holds exactly one review, which is what a pane renders before the switcher
 *  appears. Tests that do not exercise switching should read this rather than spell the shape out. */
export function makeWorkspaceReviewSelection(
  overrides: Partial<WorkspaceReviewSelection> = {}
): WorkspaceReviewSelection {
  return {
    entries: [],
    selected: null,
    isWorkspaceReview: true,
    hasMultiple: false,
    selectedReview: null,
    selectReview: () => {},
    refreshSelectedReview: async () => null,
    ...overrides
  }
}

/** One entry for a two-review workspace, where `entries[0]` is the workspace's own review. */
export function makeWorkspaceReviewSelectionEntry(
  overrides: Partial<WorkspaceReviewSelectionEntry> = {}
): WorkspaceReviewSelectionEntry {
  return {
    key: 'github:42',
    provider: 'github',
    number: 42,
    title: 'A review',
    url: 'https://github.com/acme/orca/pull/42',
    attachment: null,
    ...overrides
  }
}
