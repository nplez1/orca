import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'

/** One collapsed review thread reduced to a marker. */
export type PRCommentGutterMark = {
  /** Inline comment id, handed back to `onActivate`. */
  id: string
  line: number
}

/**
 * Draws a clickable bubble in the glyph margin for each collapsed review thread.
 *
 * Why the glyph margin rather than a view zone: a collapsed thread must not move any code, and the
 * gutter is where a reader already looks for per-line annotations. Monaco's built-in right-click
 * gutter menu reads `GUTTER_LINE_NUMBERS`, which is a separate target type, so the two coexist.
 *
 * Monaco defaults `glyphMargin` to false, and turning it on reserves a gutter column, so it is only
 * enabled while this file actually has a collapsed thread — a file with no review comments looks
 * exactly as it did before.
 */
export function usePRCommentGutterMarks(args: {
  editor: monacoEditor.ICodeEditor | null
  /** Model-scoped decorations: Monaco drops them on model swap even though the editor is stable. */
  monacoModelIdentity?: string
  marks: readonly PRCommentGutterMark[]
  onActivate: (commentId: string) => void
}): void {
  const { editor, monacoModelIdentity, marks, onActivate } = args
  const marksRef = useRef(marks)
  const onActivateRef = useRef(onActivate)
  marksRef.current = marks
  onActivateRef.current = onActivate

  // Why: read the marks through a ref so a click always resolves against the current set without
  // re-subscribing every time the thread list changes identity.
  useEffect(() => {
    if (!editor) {
      return
    }
    const subscription = editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        return
      }
      const line = event.target.position?.lineNumber
      if (line === undefined) {
        return
      }
      // Why: every glyph-margin cell is a hit target, not just decorated ones — an undecorated
      // click must fall through to whatever Monaco would otherwise do with it.
      const mark = marksRef.current.find((candidate) => candidate.line === line)
      if (!mark) {
        return
      }
      event.event.preventDefault()
      onActivateRef.current(mark.id)
    })
    return () => subscription.dispose()
  }, [editor, monacoModelIdentity])

  useEffect(() => {
    editor?.updateOptions({ glyphMargin: marks.length > 0 })
    if (!editor || marks.length === 0) {
      return
    }
    const collection = editor.createDecorationsCollection(
      marks.map((mark) => ({
        range: new monaco.Range(mark.line, 1, mark.line, 1),
        options: { isWholeLine: false, glyphMarginClassName: 'orca-pr-comment-gutter-mark' }
      }))
    )
    return () => collection.clear()
  }, [editor, marks, monacoModelIdentity])
}
