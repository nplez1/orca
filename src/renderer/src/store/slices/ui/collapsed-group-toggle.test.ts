import { describe, expect, it } from 'vitest'
import { toggleCollapsedGroupKeysSet } from './collapsed-group-toggle'

describe('toggleCollapsedGroupKeysSet', () => {
  it('folds every key when any of them is still unfolded', () => {
    expect([...toggleCollapsedGroupKeysSet(new Set(['a']), ['a', 'b'])]).toEqual(['a', 'b'])
  })

  it('unfolds every key once all of them are folded', () => {
    expect([...toggleCollapsedGroupKeysSet(new Set(['a', 'b', 'other']), ['a', 'b'])]).toEqual([
      'other'
    ])
  })

  it('toggles each distinct key once', () => {
    expect([...toggleCollapsedGroupKeysSet(new Set<string>(), ['a', 'a', 'b'])]).toEqual(['a', 'b'])
  })
})
