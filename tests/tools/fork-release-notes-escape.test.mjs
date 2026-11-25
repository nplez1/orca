// A commit subject reaches a body this fork publishes automatically, so it is untrusted Markdown.
// These pin the two shapes a backslash escape cannot stop — a mention and an autolink — because the
// first version of this escaper shipped them and looked correct.
import { describe, expect, it } from 'vitest'
import { escapeReleaseText } from '../../.github/scripts/fork-release-notes.mjs'

const ZWSP = '\u200B'

describe('release note subject escaping', () => {
  it('breaks a mention, which a backslash does not', () => {
    expect(escapeReleaseText('thanks @octocat')).toBe(`thanks @${ZWSP}octocat`)
  })

  it('breaks a bare URL so it cannot autolink', () => {
    expect(escapeReleaseText('see https://example.com/x')).toBe(`see https:${ZWSP}//example.com/x`)
  })

  it('defuses markdown link syntax and raw html', () => {
    expect(escapeReleaseText('[click](https://example.com)')).toBe(
      `\\[click\\]\\(https:${ZWSP}//example.com\\)`
    )
    expect(escapeReleaseText('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('breaks issue, commit and www references, which a backslash does not', () => {
    expect(escapeReleaseText('#12 nplez1/orca#13 GH-14')).toBe(
      `\\#${ZWSP}12 nplez1/orca\\#${ZWSP}13 GH${ZWSP}-14`
    )
    expect(escapeReleaseText('www.example.com')).toBe(`www${ZWSP}.example.com`)
  })

  it('leaves ordinary prose alone', () => {
    expect(escapeReleaseText('renderer: the labels popover no longer drops an edit')).toBe(
      'renderer: the labels popover no longer drops an edit'
    )
  })
})
