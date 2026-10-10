// @vitest-environment happy-dom

import React, { useCallback, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommentComposer,
  commentMarkdownForSubmit,
  type CommentComposerProps
} from './comment-composer'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ShortcutKeyCombo', () => ({
  ShortcutKeyCombo: () => <span />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: Record<string, unknown> }) => unknown) =>
    selector({ settings: {} })
}))

beforeEach(() => {
  // Why: the composer reads the submit modifier off the user agent; pin the
  // non-Mac branch so the test drives Ctrl+Enter on any runner.
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('X11; Linux x86_64')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderComposer({
  initialValue = '',
  ...overrides
}: Partial<CommentComposerProps> & { initialValue?: string } = {}): {
  onValueChange: ReturnType<typeof vi.fn>
  editor: HTMLElement
} {
  const onValueChange = vi.fn()
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState(initialValue)
    const handleChange = useCallback((next: string) => {
      onValueChange(next)
      setValue(next)
    }, [])
    return (
      <>
        <CommentComposer
          value={value}
          onValueChange={handleChange}
          onSubmit={() => {}}
          placeholder="Add a comment"
          submitLabel="Comment"
          canSubmit={value.trim().length > 0}
          {...overrides}
        />
        <output data-testid="draft">{value}</output>
      </>
    )
  }
  render(<Harness />)
  return {
    onValueChange,
    editor: screen.getByRole('textbox', { name: 'Add a comment' })
  }
}

function selectAll(editor: HTMLElement): void {
  fireEvent.keyDown(editor, { key: 'a', ctrlKey: true })
}

describe('CommentComposer', () => {
  it('renders the draft as formatted text rather than markdown source', () => {
    const { editor } = renderComposer({ initialValue: '**bold** and _italic_ and `code`' })

    expect(editor.querySelector('strong')?.textContent).toBe('bold')
    expect(editor.querySelector('em')?.textContent).toBe('italic')
    expect(editor.querySelector('code')?.textContent).toBe('code')
    expect(editor.textContent).toBe('bold and italic and code')
  })

  it('restyles the selection in place instead of inserting markdown around it', async () => {
    const { editor, onValueChange } = renderComposer({ initialValue: 'ship it' })

    selectAll(editor)
    fireEvent.click(screen.getByLabelText('Bold'))

    await waitFor(() => expect(editor.querySelector('strong')?.textContent).toBe('ship it'))
    expect(onValueChange).toHaveBeenLastCalledWith('**ship it**')
  })

  // Why: the reported behaviour — press the button, then type, and the text comes
  // out bolded rather than wrapped in source. A collapsed caret has no selection
  // to restyle, so this depends on the mark being stored for the next input.
  // Why no value echo here: re-rendering the composer between keystrokes makes
  // happy-dom lose the caret and drop or substitute a character — a limitation of
  // the DOM stub, not of the composer (a bare tiptap editor types 10/10 clean,
  // and the trace shows the value never moves backwards, so nothing is rewritten).
  // The path where the parent replaces the value is covered by 'renders a value
  // the parent changes after mount'.
  it.each([
    ['Bold', 'strong', '**bolded**', 'bolded'],
    ['Italic', 'em', '*italicised*', 'italicised']
  ])('formats text typed after %s is pressed', async (label, tag, markdown, word) => {
    const onValueChange = vi.fn()
    render(
      <CommentComposer
        value=""
        onValueChange={onValueChange}
        onSubmit={() => {}}
        placeholder="Add a comment"
        submitLabel="Comment"
        canSubmit
      />
    )
    const editor = screen.getByRole('textbox', { name: 'Add a comment' })

    fireEvent.click(screen.getByLabelText(label))
    await userEvent.type(editor, word)

    expect(editor.querySelector(tag)?.textContent).toBe(word)
    // Why: the source markers must never be visible in the editing surface.
    expect(editor.textContent).toBe(word)
    expect(onValueChange).toHaveBeenLastCalledWith(markdown)
  })

  it('reports the active formats on the toolbar toggles', async () => {
    const { editor } = renderComposer({ initialValue: '**bold**' })
    const boldPressed = (): string | null =>
      screen.getByLabelText('Bold').getAttribute('aria-pressed')

    selectAll(editor)
    await waitFor(() => expect(boldPressed()).toBe('true'))

    fireEvent.click(screen.getByLabelText('Bold'))
    await waitFor(() => expect(boldPressed()).toBe('false'))
  })

  it('submits on the platform modifier and leaves a plain Enter to the editor', () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ initialValue: 'Looks good', onSubmit })

    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables the send action until the body can be submitted', () => {
    renderComposer({ initialValue: 'Ready', canSubmit: false })

    expect(screen.getByRole('button', { name: 'Comment' }).hasAttribute('disabled')).toBe(true)
  })

  it('enables the send action once the body can be submitted', () => {
    renderComposer({ initialValue: 'Ready', canSubmit: true })

    expect(screen.getByRole('button', { name: 'Comment' }).hasAttribute('disabled')).toBe(false)
  })

  it('sends from an icon-only ghost button rather than a filled disc', () => {
    renderComposer({ initialValue: 'Ready', canSubmit: true })
    const send = screen.getByRole('button', { name: 'Comment' })

    expect(send.getAttribute('data-variant')).toBe('ghost')
    expect(send.querySelector('svg')).toBeTruthy()
    expect(send.textContent).toBe('')
  })

  it('keeps the send action and the editing surface locked while submitting', () => {
    const { editor } = renderComposer({ initialValue: 'Ready', canSubmit: true, submitting: true })

    expect(screen.getByRole('button', { name: 'Comment' }).hasAttribute('disabled')).toBe(true)
    expect(editor.getAttribute('contenteditable')).toBe('false')
  })

  // Why: the parent clears the draft in the same commit that ends "submitting",
  // and setEditable emits an update by default — that stray update used to push
  // the just-posted comment straight back into the draft, so a second Cmd+Enter
  // posted it twice.
  it('does not restore the draft when a post succeeds', async () => {
    function SubmitHarness(): React.JSX.Element {
      const [value, setValue] = useState('Looks good to me')
      const [submitting, setSubmitting] = useState(false)
      return (
        <>
          <CommentComposer
            value={value}
            onValueChange={setValue}
            onSubmit={() => setSubmitting(true)}
            placeholder="Add a comment"
            submitLabel="Comment"
            canSubmit={value.trim().length > 0}
            submitting={submitting}
          />
          <button
            type="button"
            onClick={() => {
              setValue('')
              setSubmitting(false)
            }}
          >
            finish-post
          </button>
          <output data-testid="draft">{value}</output>
        </>
      )
    }
    render(<SubmitHarness />)
    const editor = screen.getByRole('textbox', { name: 'Add a comment' })

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'finish-post' }))

    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(''))
    expect(editor.textContent).toBe('')
  })
})

describe('commentMarkdownForSubmit', () => {
  // Why: the Jira converter renders one paragraph per source line, so the
  // editor's paragraph breaks have to collapse — otherwise every Enter posts a
  // blank line, which the plain-textarea composer never did.
  it('flattens paragraph breaks to a single line break', () => {
    expect(commentMarkdownForSubmit('first\n\nsecond\n')).toBe('first\nsecond\n')
  })

  // Why: this tiptap version writes a hard break as two trailing spaces, not as a
  // backslash, so the trailing whitespace goes — and the blank lines collapse.
  it('flattens the editor hard break and runs of blank lines', () => {
    expect(commentMarkdownForSubmit('one  \ntwo\n\n\n\nthree\n')).toBe('one\ntwo\nthree\n')
  })

  it('drops the placeholder an empty paragraph serializes as', () => {
    expect(commentMarkdownForSubmit('first\n\n&nbsp;\n')).toBe('first\n')
    expect(commentMarkdownForSubmit('a\n\n&nbsp;\n\nb\n')).toBe('a\nb\n')
  })

  // Why: the composer is a controlled field, so a value the parent replaces after
  // mount (a restored draft) has to reach the editing surface.
  it('renders a value the parent changes after mount', () => {
    function Harness(): React.JSX.Element {
      const [value, setValue] = useState('first')
      return (
        <>
          <CommentComposer
            value={value}
            onValueChange={setValue}
            onSubmit={() => {}}
            placeholder="Add a comment"
            submitLabel="Comment"
            canSubmit
          />
          <button type="button" onClick={() => setValue('**replaced**')}>
            replace
          </button>
        </>
      )
    }
    render(<Harness />)
    const editor = screen.getByRole('textbox', { name: 'Add a comment' })
    expect(editor.textContent).toBe('first')

    fireEvent.click(screen.getByRole('button', { name: 'replace' }))

    expect(editor.querySelector('strong')?.textContent).toBe('replaced')
    expect(editor.textContent).toBe('replaced')
  })

  // Why: only a whole-line placeholder is the serializer's; an inline `&nbsp;` is
  // something the user typed, and a developer writing about HTML will write it.
  it('keeps an inline code span that contains &nbsp;', () => {
    expect(commentMarkdownForSubmit('use `&nbsp;` for spacing\n')).toBe(
      'use `&nbsp;` for spacing\n'
    )
  })

  it('keeps a quote marker the placeholder was carrying', () => {
    expect(commentMarkdownForSubmit('> q1\n> &nbsp;\n> q2\n')).toBe('> q1\n> q2\n')
  })

  // Why: the editor leaves an empty bullet behind when the caret is on a new list
  // item at submit time; trimming the marker off it would post a literal `-`.
  it('drops an empty bullet rather than leaving a bare marker', () => {
    expect(commentMarkdownForSubmit('- a\n- \n')).toBe('- a\n')
    expect(commentMarkdownForSubmit('* a\n*\n')).toBe('* a\n')
  })

  it("flattens a quote's own blank line", () => {
    expect(commentMarkdownForSubmit('> q1\n>\n> q2\n')).toBe('> q1\n> q2\n')
  })

  // Why: a non-breaking space is common in pasted web text, and deleting it
  // fuses the words on either side of it.
  it('turns a real non-breaking space into a space instead of deleting it', () => {
    expect(commentMarkdownForSubmit('see\u00a0docs\n')).toBe('see docs\n')
    expect(commentMarkdownForSubmit('prix\u00a0: 5\n')).toBe('prix : 5\n')
  })

  // Why: a pasted snippet's blank lines are its content.
  it('leaves a fenced code block byte-for-byte alone', () => {
    expect(commentMarkdownForSubmit('```\nx\n\n\nz\n```\n')).toBe('```\nx\n\n\nz\n```\n')
    expect(commentMarkdownForSubmit('```\n&nbsp; &amp;\n```\n')).toBe('```\n&nbsp; &amp;\n```\n')
  })

  it('still flattens the prose around a fence', () => {
    expect(commentMarkdownForSubmit('a\n\n```\nx\n```\n\nb\n')).toBe('a\n```\nx\n```\nb\n')
  })

  it('leaves inline formatting untouched', () => {
    expect(commentMarkdownForSubmit('**bold** and *italic* and `code`\n')).toBe(
      '**bold** and *italic* and `code`\n'
    )
  })
})
