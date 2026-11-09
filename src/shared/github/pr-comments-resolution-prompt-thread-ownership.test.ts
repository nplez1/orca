import { describe, expect, it } from 'vitest'

import { buildPRCommentsResolutionPrompt } from '../source-control/review-comments/pr-comments-resolution-prompt'

describe('buildPRCommentsResolutionPrompt thread ownership', () => {
  it('names the reviewer or the user as the one who closes a thread', () => {
    // Why: #166 — the prompt states who closes a thread, so an agent never assumes
    // Orca resolved it on its behalf.
    const prompt = buildPRCommentsResolutionPrompt({
      reviewKind: 'PR',
      reviewNumber: 42,
      reviewTitle: 'Fix parser',
      reviewUrl: 'https://github.com/acme/widgets/pull/42',
      groups: []
    })

    expect(prompt).toContain('The reviewer or the user closes a thread once they verify the fix')
    expect(prompt).toContain('Do not resolve or unresolve threads on the host')
  })
})
