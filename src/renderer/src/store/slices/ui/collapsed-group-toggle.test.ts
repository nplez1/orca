import { describe, expect, it } from 'vitest'
import { toggleCollapsedGroupKeysSet } from './collapsed-group-toggle'

describe('toggleCollapsedGroupKeysSet', () => {
  it('folds every key when none of them is folded', () => {
    expect([...toggleCollapsedGroupKeysSet(new Set<string>(), ['a', 'b'])]).toEqual(['a', 'b'])
  })

  // Why: a card reads folded while any key is folded, so folding a half-folded set
  // would change nothing on screen.
  it('unfolds every key when only some of them are folded', () => {
    expect([...toggleCollapsedGroupKeysSet(new Set(['a', 'other']), ['a', 'b'])]).toEqual(['other'])
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
