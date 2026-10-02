// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { usePRCommentGutterMarks, type PRCommentGutterMark } from './usePRCommentGutterMarks'

afterEach(cleanup)

type EditorSpy = {
  /** The slice of ICodeEditor the hook reaches for. */
  editor: monacoEditor.ICodeEditor
  updateOptions: ReturnType<typeof vi.fn>
  createDecorationsCollection: ReturnType<typeof vi.fn>
  collection: { clear: ReturnType<typeof vi.fn> }
  pressGlyphMargin: (line: number) => void
}

/** The hook reads only target.type, target.position and event.preventDefault. */
function glyphMarginClickEvent(line: number): monacoEditor.IEditorMouseEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only target.type, target.position, and event.preventDefault/stopPropagation.
  const event = {
    target: {
      type: monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
      position: { lineNumber: line, column: 1 }
    },
    event: { preventDefault: vi.fn(), stopPropagation: vi.fn() }
  } as unknown as monacoEditor.IEditorMouseEvent
  return event
}

function createEditorSpy(): EditorSpy {
  let mouseDownHandler: ((event: monacoEditor.IEditorMouseEvent) => void) | null = null
  const collection = { clear: vi.fn(), set: vi.fn() }
  const spy = {
    updateOptions: vi.fn(),
    createDecorationsCollection: vi.fn(() => collection),
    onMouseDown: (handler: (event: monacoEditor.IEditorMouseEvent) => void) => {
      mouseDownHandler = handler
      return { dispose: vi.fn() }
    }
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook touches only the four members above; the rest of ICodeEditor is unreachable from it.
    editor: spy as unknown as monacoEditor.ICodeEditor,
    updateOptions: spy.updateOptions,
    createDecorationsCollection: spy.createDecorationsCollection,
    collection,
    pressGlyphMargin: (line) => mouseDownHandler?.(glyphMarginClickEvent(line))
  }
}

function Harness({
  editor,
  marks,
  onActivate
}: {
  editor: monacoEditor.ICodeEditor | null
  marks: readonly PRCommentGutterMark[]
  onActivate: (commentId: string) => void
}): React.JSX.Element | null {
  usePRCommentGutterMarks({ editor, marks, onActivate })
  return null
}

describe('usePRCommentGutterMarks', () => {
  it('relies on the standalone build disabling the gutter by default', () => {
    // Why pinned: the hook turns glyphMargin on for a file with collapsed threads and off when it has
    // none, which is what keeps a file with no review comments laid out as it was. That holds only
    // while the option defaults to false — the raw registry registers it as true, and
    // `esm/vs/editor/editor.api2.js`, the standalone entry monaco-editor ships, overrides it. A bump
    // that dropped the override would make this hook remove a gutter column other surfaces keep.
    expect(monaco.editor.EditorOptions.glyphMargin.defaultValue).toBe(false)
    expect(monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN).toBe(2)
  })

  it('enables the gutter for a collapsed thread and releases it when there is none', () => {
    const spy = createEditorSpy()
    const { rerender } = render(<Harness editor={spy.editor} marks={[]} onActivate={vi.fn()} />)
    // Why: an empty list must still write false, or a retained editor that just showed a commented
    // file keeps its gutter column on the next file.
    expect(spy.updateOptions).toHaveBeenCalledWith({ glyphMargin: false })

    spy.updateOptions.mockClear()
    rerender(<Harness editor={spy.editor} marks={[{ id: 'c1', line: 12 }]} onActivate={vi.fn()} />)
    expect(spy.updateOptions).toHaveBeenCalledWith({ glyphMargin: true })

    spy.updateOptions.mockClear()
    rerender(<Harness editor={spy.editor} marks={[]} onActivate={vi.fn()} />)
    expect(spy.updateOptions).toHaveBeenCalledWith({ glyphMargin: false })
  })

  it('paints the marker class on the commented line and clears it on unmount', () => {
    const spy = createEditorSpy()
    const { unmount } = render(
      <Harness editor={spy.editor} marks={[{ id: 'c1', line: 12 }]} onActivate={vi.fn()} />
    )

    expect(spy.createDecorationsCollection).toHaveBeenCalledWith([
      {
        range: expect.anything(),
        options: { isWholeLine: false, glyphMarginClassName: 'orca-pr-comment-gutter-mark' }
      }
    ])
    unmount()
    expect(spy.collection.clear).toHaveBeenCalled()
  })

  it('activates the thread whose line was clicked in the gutter', () => {
    const spy = createEditorSpy()
    const onActivate = vi.fn()
    render(
      <Harness
        editor={spy.editor}
        marks={[
          { id: 'comment-a', line: 12 },
          { id: 'comment-b', line: 40 }
        ]}
        onActivate={onActivate}
      />
    )

    act(() => spy.pressGlyphMargin(40))
    expect(onActivate).toHaveBeenCalledWith('comment-b')

    // Why: every glyph-margin cell is a hit target; an undecorated line must not open a thread.
    onActivate.mockClear()
    act(() => spy.pressGlyphMargin(7))
    expect(onActivate).not.toHaveBeenCalled()
  })
})
