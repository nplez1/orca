// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import {
  Q1,
  Q2,
  repo,
  view,
  Harness,
  installSourceDisplayTestLifecycle
} from '../use-task-page-source-display.test-fixture'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))

installSourceDisplayTestLifecycle()

describe('useTaskPageGitHubListState', () => {
  it('retires a next-page failure when the list it belonged to is replaced', () => {
    useAppStore.setState({
      repos: [repo],
      settings: createGlobalSettingsFixture({ defaultRepoSelection: [repo.id] }),
      taskPageData: { taskSource: 'github' }
    })
    render(<Harness />)
    act(() => view.setAppliedTaskSearch(Q1))
    act(() => view.setPaginationError({ page: 2, message: 'Couldn’t load page 3 — offline' }))
    expect(view.paginationError).toEqual({ page: 2, message: 'Couldn’t load page 3 — offline' })

    // Why: keyed-only hiding would let the banner reappear on the way back to the old query.
    act(() => view.setAppliedTaskSearch(Q2))
    expect(view.paginationError).toBeNull()
    act(() => view.setAppliedTaskSearch(Q1))
    expect(view.paginationError).toBeNull()
  })
})
