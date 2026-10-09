import { describe, expect, it } from 'vitest'
import { textToAdf } from './adf-markdown'
import { markdownCommentBody, markdownToAdf, markdownToJiraWiki } from './jira-comment-body'
import type { JiraSite } from '../../shared/jira-types'

function site(overrides: Partial<JiraSite> = {}): JiraSite {
  return {
    id: 'site-1',
    siteUrl: 'https://example.atlassian.net',
    email: 'ada@example.com',
    displayName: 'Example Jira',
    accountId: 'account-1',
    ...overrides
  }
}

describe('comment body conversion', () => {
  // The composer's toolbar inserts Markdown; Server/DC renders wiki markup.
  it('writes the toolbar constructs as Jira wiki markup', () => {
    expect(markdownToJiraWiki('**bold**')).toBe('{*}bold{*}')
    expect(markdownToJiraWiki('_italic_')).toBe('{_}italic{_}')
    expect(markdownToJiraWiki('`code`')).toBe('{{code}}')
    expect(markdownToJiraWiki('> quoted')).toBe('{quote}\nquoted\n{quote}')
    expect(markdownToJiraWiki('- one\n- two')).toBe('* one\n* two')
  })

  it('leaves a body with no formatting byte-for-byte alone', () => {
    for (const body of ['just a note', 'line one\nline two', 'gap\n\nbelow', '', 'a_b_c']) {
      expect(markdownToJiraWiki(body)).toBe(body)
    }
  })

  it('keeps a code span literal', () => {
    expect(markdownToJiraWiki('`**not bold**`')).toBe('{{**not bold**}}')
  })

  it('writes the toolbar constructs as ADF marks and nodes', () => {
    const doc = markdownToAdf('**bold** and _italic_ and `code`')

    expect(doc).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] }
          ]
        }
      ]
    })
  })

  it('writes a quote and a list as their own ADF nodes', () => {
    const doc = markdownToAdf('> quoted\n\n- one\n- two')
    const content = doc.content
    if (!Array.isArray(content)) {
      throw new Error('expected ADF content nodes')
    }
    const [quote, empty, list] = content

    expect(quote).toEqual({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }]
    })
    expect(empty).toEqual({ type: 'paragraph', content: [] })
    expect(list).toEqual({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }]
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }]
        }
      ]
    })
  })

  // Every comment that predates the toolbar went out through `textToAdf`, so the
  // converter has to agree with it wherever no Markdown is present.
  it('matches the plain-text ADF shape for unformatted bodies', () => {
    for (const body of ['just a note', 'line one\nline two', 'gap\n\nbelow', '']) {
      expect(markdownToAdf(body)).toEqual(textToAdf(body))
    }
  })

  it('honours an escaped marker instead of formatting it', () => {
    expect(markdownToJiraWiki('\\_literal\\_')).toBe('_literal_')
    expect(markdownToJiraWiki('\\*\\*not bold\\*\\*')).toBe('**not bold**')
  })

  it('treats a fenced block as a protected region', () => {
    const body = '```console\n- not a list\n> not a quote\n```'

    expect(markdownToJiraWiki(body)).toBe('{code:console}\n- not a list\n> not a quote\n{code}')
    expect(markdownToAdf(body)).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'console' },
          content: [{ type: 'text', text: '- not a list\n> not a quote' }]
        }
      ]
    })
  })

  it('reads a carriage return the way the plain-text path does', () => {
    // Byte parity for wiki, separator parity for ADF: `textToAdf` splits on \r?\n.
    expect(markdownToJiraWiki('one\r\ntwo')).toBe('one\r\ntwo')
    expect(markdownToAdf('one\r\ntwo')).toEqual(textToAdf('one\r\ntwo'))
  })

  it('does not emphasise an intraword underscore', () => {
    expect(markdownToJiraWiki('snake_case_name')).toBe('snake_case_name')
  })

  it('picks the format the site takes', () => {
    expect(markdownCommentBody(site({ authType: 'server' }), '**bold**')).toBe('{*}bold{*}')
    expect(markdownCommentBody(site(), '**bold**')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }]
        }
      ]
    })
  })
})
