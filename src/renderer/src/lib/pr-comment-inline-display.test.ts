import { describe, expect, it } from 'vitest'
import { resolvePRCommentInlineDisplay } from './pr-comment-inline-display'

describe('resolvePRCommentInlineDisplay', () => {
  it('draws an unresolved thread open while the setting is on', () => {
    expect(
      resolvePRCommentInlineDisplay({ override: undefined, enabled: true, isResolved: false })
    ).toBe('expanded')
  })

  it('reduces a resolved thread to its gutter marker', () => {
    expect(
      resolvePRCommentInlineDisplay({ override: undefined, enabled: true, isResolved: true })
    ).toBe('collapsed')
  })

  it('collapses everything when the setting is off', () => {
    expect(
      resolvePRCommentInlineDisplay({ override: undefined, enabled: false, isResolved: false })
    ).toBe('collapsed')
  })

  it('honours an explicit expansion even while the setting is off', () => {
    expect(
      resolvePRCommentInlineDisplay({ override: 'expanded', enabled: false, isResolved: false })
    ).toBe('expanded')
  })

  it('honours an explicit collapse and a reopened resolved thread', () => {
    expect(
      resolvePRCommentInlineDisplay({ override: 'collapsed', enabled: true, isResolved: false })
    ).toBe('collapsed')
    expect(
      resolvePRCommentInlineDisplay({ override: 'expanded', enabled: true, isResolved: true })
    ).toBe('expanded')
  })
})
