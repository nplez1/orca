// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubPageLoadError } from './use-task-page-github-list-state'
import { useTaskPageGitHubSearchPagination } from './use-task-page-github-search-pagination'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'local'
}

function issue(number: number): GitHubWorkItem {
  return {
    id: `issue-${number}`,
    repoId: repo.id,
    number,
    type: 'issue',
    title: `Issue ${number}`,
    state: 'open',
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    author: null,
    updatedAt: '2026-11-04'
  }
}

type PaginationInput = Parameters<typeof useTaskPageGitHubSearchPagination>[0]
type FetchNextPage = PaginationInput['fetchWorkItemsNextPage']

function harness(fetchWorkItemsNextPage: FetchNextPage) {
  return renderHook(() => {
    const [pages, setPages] = useState<(GitHubWorkItem[] | null)[]>([[issue(1)]])
    const [currentPage, setCurrentPage] = useState(0)
    const [paginationLoading, setPaginationLoading] = useState(false)
    const [loadingTargetPage, setLoadingTargetPage] = useState<number | null>(null)
    const [paginationError, setPaginationError] = useState<GitHubPageLoadError | null>(null)
    const [countedTotalPages, setCountedTotalPages] = useState<number | null>(null)
    const [provenPageLimit, setProvenPageLimit] = useState<number | null>(null)
    const pagesRef = useRef(pages)
    const currentPageRef = useRef(currentPage)
    const paginationGenerationRef = useRef(0)
    const countedTotalPagesRef = useRef<number | null>(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields listed here; the projection it types against supplies the rest, which its paging path never touches.
    const model = {
      setTaskResumeState: vi.fn(),
      selectedRepos: [repo],
      githubSearchPersistReadyRef: useRef(false),
      taskResumeApplied: false,
      taskSearchInput: '',
      appliedTaskSearch: 'is:issue',
      setAppliedTaskSearch: vi.fn(),
      activeTaskPreset: null,
      setTasksFiltering: vi.fn(),
      paginationGenerationRef,
      githubPerRepoPageLimit: 36,
      githubPageSize: 36,
      setPages,
      currentPage,
      setCurrentPage,
      pagesRef,
      currentPageRef,
      paginationLoading,
      setPaginationLoading,
      setLoadingTargetPage,
      setPaginationError,
      setCountedTotalPages,
      setProvenPageLimit,
      countedTotalPagesRef,
      fetchWorkItemsNextPage,
      activeGithubTaskKind: 'issues'
    } as unknown as PaginationInput
    const withPagination = useTaskPageGitHubSearchPagination(model)
    return {
      model: withPagination,
      pages,
      currentPage,
      paginationLoading,
      loadingTargetPage,
      paginationError,
      paginationGenerationRef,
      countedTotalPages,
      provenPageLimit
    }
  })
}

afterEach(cleanup)

describe('useTaskPageGitHubSearchPagination', () => {
  it('reports a rejected next-page read with the reason and the page it failed on', async () => {
    const fetchWorkItemsNextPage = vi.fn<FetchNextPage>(async () => {
      throw new Error(
        "Error invoking remote method 'gh:list-work-items': Error: getaddrinfo ENOTFOUND api.github.com"
      )
    })
    const { result } = harness(fetchWorkItemsNextPage)

    await act(async () => {
      await result.current.model.handleLoadNextPage()
    })

    expect(result.current.paginationError?.page).toBe(1)
    expect(result.current.paginationError?.message).toContain('page 2')
    expect(result.current.paginationError?.message).toContain(
      'getaddrinfo ENOTFOUND api.github.com'
    )
    // The rows already shown stay put, and the spinner clears so the page is clickable again.
    expect(result.current.pages).toEqual([[issue(1)]])
    expect(result.current.paginationLoading).toBe(false)
    expect(result.current.loadingTargetPage).toBeNull()
  })

  it('loads the same page when the retry is made after recovery', async () => {
    const fetchWorkItemsNextPage = vi
      .fn<FetchNextPage>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [issue(2)], failedCount: 0, errorTypes: [] })
    const { result } = harness(fetchWorkItemsNextPage)

    await act(async () => {
      await result.current.model.handleLoadNextPage()
    })
    const failedPage = result.current.paginationError?.page
    expect(failedPage).toBe(1)

    await act(async () => {
      await result.current.model.handleLoadNextPage(failedPage)
    })

    expect(result.current.paginationError).toBeNull()
    expect(result.current.currentPage).toBe(1)
    expect(result.current.pages[1]).toEqual([issue(2)])
  })

  it('stays quiet about a failure the list has already moved past', async () => {
    let rejectPage: (error: Error) => void = () => {}
    const fetchWorkItemsNextPage = vi.fn<FetchNextPage>(
      () =>
        new Promise<Awaited<ReturnType<FetchNextPage>>>((_resolve, reject) => {
          rejectPage = reject
        })
    )
    const { result } = harness(fetchWorkItemsNextPage)

    await act(async () => {
      const pending = result.current.model.handleLoadNextPage()
      result.current.paginationGenerationRef.current += 1
      rejectPage(new Error('offline'))
      await pending
    })

    expect(result.current.paginationError).toBeNull()
  })
})
