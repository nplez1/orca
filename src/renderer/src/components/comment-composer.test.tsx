// @vitest-environment happy-dom

import React, { useCallback, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommentComposer, type CommentComposerProps } from './comment-composer'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ShortcutKeyCombo', () => ({
  ShortcutKeyCombo: () => <span />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
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

function renderComposer(overrides: Partial<CommentComposerProps> = {}): HTMLTextAreaElement {
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState('')
    const onSubmit = useCallback(() => {}, [])
    return (
      <CommentComposer
        value={value}
        onValueChange={setValue}
        onSubmit={onSubmit}
        placeholder="Add a comment"
        submitLabel="Comment"
        canSubmit={value.trim().length > 0}
        {...overrides}
      />
    )
  }
  render(<Harness />)
  return screen.getByPlaceholderText('Add a comment')
}

describe('CommentComposer', () => {
  it('inserts markdown around the caret and keeps the caret inside it', async () => {
    const textarea = renderComposer()

    fireEvent.click(screen.getByLabelText('Bold'))

    expect(textarea.value).toBe('**strong text**')
    // Why: the caret can only be restored after React commits the new value, so
    // the restore is deferred by a tick.
    await waitFor(() => expect(textarea.selectionStart).toBe(2))
    expect(textarea.selectionEnd).toBe(2 + 'strong text'.length)
  })

  it('wraps the selected text instead of the placeholder', () => {
    const textarea = renderComposer()
    fireEvent.change(textarea, { target: { value: 'ship it' } })
    textarea.setSelectionRange(0, 7)

    fireEvent.click(screen.getByLabelText('Italic'))

    expect(textarea.value).toBe('_ship it_')
  })

  it('submits on the platform modifier and leaves a plain Enter to the textarea', () => {
    const onSubmit = vi.fn()
    const textarea = renderComposer({ onSubmit })
    fireEvent.change(textarea, { target: { value: 'Looks good' } })

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables the send action until the body can be submitted', () => {
    const textarea = renderComposer({ canSubmit: false })
    fireEvent.change(textarea, { target: { value: 'Ready' } })

    const send = screen.getByRole('button', { name: 'Comment' })
    expect(send.hasAttribute('disabled')).toBe(true)

    fireEvent.click(send)
    expect(send.hasAttribute('disabled')).toBe(true)
  })

  it('enables the send action once the body can be submitted', () => {
    renderComposer({ canSubmit: true })

    expect(screen.getByRole('button', { name: 'Comment' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps the send action in place while the comment is submitting', () => {
    renderComposer({ canSubmit: true, submitting: true })

    const send = screen.getByRole('button', { name: 'Comment' })
    expect(send.hasAttribute('disabled')).toBe(true)
    expect(screen.getByPlaceholderText('Add a comment').hasAttribute('disabled')).toBe(true)
  })
})
