// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  favouritePageMeta,
  resetFavouriteTransport,
  useFavouriteTaskPage
} from '../../__mocks__/task-page-jira-favourite-fixture'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  resetFavouriteTransport()
})

// Why this layer: the page a read returns only reaches the list through the effects hook,
// and a hook that dropped it would leave the header and footer claiming the list is whole.
it('carries the page a list read reported into the model', async () => {
  favouritePageMeta.hasMore = true
  favouritePageMeta.total = 312
  const { result } = renderHook(() => useFavouriteTaskPage())

  await waitFor(() =>
    expect(result.current.jiraListPage).toMatchObject({ hasMore: true, total: 312 })
  )
})

it('reports no page at all for a view that is never truncated', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())

  await waitFor(() => expect(result.current.jiraListPage).not.toBeNull())
  act(() => result.current.setJiraHasWorkspace(true))

  // The linked-workspace view is never truncated, so it must not inherit a page either.
  await waitFor(() => expect(result.current.jiraListPage).toBeNull())
})
