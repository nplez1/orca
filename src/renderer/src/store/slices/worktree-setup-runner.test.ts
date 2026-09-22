import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

describe('worktree setup runner slice', () => {
  it('starts with nothing setting up', () => {
    expect(createTestStore().getState().setupRunningWorktreeIds).toEqual({})
  })

  it('marks a worktree as setting up and clears it again', () => {
    const store = createTestStore()

    store.getState().setWorktreeSetupRunning('wt-1', true)
    expect(store.getState().setupRunningWorktreeIds).toEqual({ 'wt-1': true })

    store.getState().setWorktreeSetupRunning('wt-1', false)
    expect(store.getState().setupRunningWorktreeIds).toEqual({})
  })

  it('keeps the map identity when the flag does not change', () => {
    const store = createTestStore()
    store.getState().setWorktreeSetupRunning('wt-1', true)
    const settled = store.getState().setupRunningWorktreeIds

    // Why: a repeat 'running: true' must not re-render every card that selects this map.
    store.getState().setWorktreeSetupRunning('wt-1', true)
    store.getState().setWorktreeSetupRunning('wt-2', false)

    expect(store.getState().setupRunningWorktreeIds).toBe(settled)
  })

  it('tracks worktrees independently', () => {
    const store = createTestStore()

    store.getState().setWorktreeSetupRunning('wt-1', true)
    store.getState().setWorktreeSetupRunning('wt-2', true)
    store.getState().setWorktreeSetupRunning('wt-1', false)

    expect(store.getState().setupRunningWorktreeIds).toEqual({ 'wt-2': true })
  })
})
