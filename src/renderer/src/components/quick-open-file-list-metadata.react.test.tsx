// @vitest-environment happy-dom

import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../shared/worktree/types'
import type { RuntimeFileListState } from './quick-open-file-list'
import {
  cancelRuntimeFileListMock,
  flushEffects,
  listRuntimeFilesMock,
  makeRemoteWorktree,
  renderProbe,
  searchRuntimeFilePathsMock,
  seedRemoteWorktree
} from './quick-open-file-list-test-harness'

// Why the source module too: `runtime-file-client` re-exports the search from
// `runtime-file-path-search-client`, so mocking only the listing module leaves the real search bound.
vi.mock('@/runtime/runtime-file-path-search-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return { searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock }
})
vi.mock('@/runtime/runtime-file-search-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

async function replaceWorktrees(worktrees: Worktree[]): Promise<void> {
  await act(async () => {
    useAppStore.setState({ worktreesByRepo: { 'repo-remote': worktrees } })
  })
  await flushEffects()
}

it('keeps a settled inventory through metadata updates', async () => {
  seedRemoteWorktree()
  const states: RuntimeFileListState[] = []
  await renderProbe({ enabled: true, states, worktreeId: 'wt-remote' })
  const settledFiles = states.at(-1)?.files
  const initialRequest = listRuntimeFilesMock.mock.calls[0]?.[1]
  const rendersBeforeUpdates = states.length

  await replaceWorktrees([{ ...makeRemoteWorktree(), head: 'commit-1' }])
  await replaceWorktrees([{ ...makeRemoteWorktree(), head: 'commit-2' }])

  expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
  expect(cancelRuntimeFileListMock).not.toHaveBeenCalled()
  expect(initialRequest?.signal?.aborted).toBe(false)
  expect(states.slice(rendersBeforeUpdates).every((state) => !state.loading)).toBe(true)
  expect(states.at(-1)?.files).toBe(settledFiles)
})

it('keeps an in-flight query through metadata updates but replaces it for changed exclusions', async () => {
  vi.useFakeTimers()
  seedRemoteWorktree()
  // Why reject on abort: the real RPC client does, and the fork's scheduler dispatches a
  // replacement only after the aborted active search settles.
  searchRuntimeFilePathsMock.mockImplementation(
    (_context: unknown, args: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        args.signal?.addEventListener('abort', () => reject(args.signal?.reason))
      })
  )
  try {
    await renderProbe({ enabled: true, states: [], query: 'target', worktreeId: 'wt-remote' })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    const initialRequest = searchRuntimeFilePathsMock.mock.calls[0]?.[1]
    await replaceWorktrees([{ ...makeRemoteWorktree(), comment: 'Updated comment' }])
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(initialRequest?.signal?.aborted).toBe(false)
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledOnce()

    const nested = { ...makeRemoteWorktree(), id: 'nested', path: '/srv/remote/nested' }
    await replaceWorktrees([makeRemoteWorktree(), nested])
    expect(initialRequest?.signal?.aborted).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(2)
    expect(searchRuntimeFilePathsMock.mock.calls[1]?.[1].excludePaths).toEqual([nested.path])

    await replaceWorktrees([makeRemoteWorktree()])
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(3)
    expect(searchRuntimeFilePathsMock.mock.calls[2]?.[1].excludePaths).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})
