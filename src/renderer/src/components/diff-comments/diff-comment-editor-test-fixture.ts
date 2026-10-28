import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'

// Script Monaco hit-test and scroll geometry without a layout engine.

export const FAKE_LINE_HEIGHT_PX = 20
export const FAKE_EDITOR_TOP_PX = 100
export const FAKE_EDITOR_HEIGHT_PX = 400

export type FakeDecoration = {
  startLine: number
  endLine: number
  className?: string | null
  marginClassName?: string | null
  glyphMarginClassName?: string | null
}

export type FakeDiffCommentEditor = {
  editor: MonacoEditor.ICodeEditor
  domNode: HTMLElement
  zones: Map<string, MonacoEditor.IViewZone>
  decorations: () => readonly FakeDecoration[]
  decorationWrites: () => number
  scrollTop: () => number
  focusCount: () => number
  emitMouseMove: (lineNumber: number) => void
  emitDispose: () => void
  /** Viewport-relative Y used by the hit-test. */
  clientYForLine: (lineNumber: number) => number
  setLineCount: (lineCount: number) => void
}

type FakeEditorOptions = {
  lineCount?: number
  /** Lines the fake hit-test refuses to resolve, standing in for Monaco returning no position. */
  unresolvableLines?: readonly number[]
  /** Monaco cannot resolve positions over the add button’s external DOM. */
  deadColumn?: { fromX: number; toX: number }
  gutterTargetType?: MonacoEditor.MouseTargetType
}

export function createFakeDiffCommentEditor(
  options: FakeEditorOptions = {}
): FakeDiffCommentEditor {
  const domNode = document.createElement('div')
  // happy-dom has no layout; supply the viewport edges used by the drag controller.
  const editorRect: DOMRect = {
    top: FAKE_EDITOR_TOP_PX,
    bottom: FAKE_EDITOR_TOP_PX + FAKE_EDITOR_HEIGHT_PX,
    left: 0,
    right: 600,
    width: 600,
    height: FAKE_EDITOR_HEIGHT_PX,
    x: 0,
    y: FAKE_EDITOR_TOP_PX,
    toJSON: () => ({})
  }
  domNode.getBoundingClientRect = () => editorRect
  document.body.appendChild(domNode)

  const zones = new Map<string, MonacoEditor.IViewZone>()
  const unresolvable = new Set(options.unresolvableLines ?? [])
  let lineCount = options.lineCount ?? 1000
  let nextZoneId = 0
  let scrollTop = 0
  let decorations: FakeDecoration[] = []
  // Each createDecorationsCollection gets its own record, the way Monaco keeps the range-drag band
  // and the gutter marks apart: clearing one must not erase the other.
  const decorationCollections = new Set<{ current: FakeDecoration[] }>()
  let decorationWrites = 0
  let focusCount = 0
  const mouseMoveListeners: ((e: { target: { position: { lineNumber: number } } }) => void)[] = []
  const disposeListeners: (() => void)[] = []
  const noopDisposable: IDisposable = { dispose: () => {} }
  // Monaco hands back the same model reference until the model is replaced.
  const model = { getLineCount: () => lineCount }

  const clientYForLine = (lineNumber: number): number =>
    FAKE_EDITOR_TOP_PX + (lineNumber - 1) * FAKE_LINE_HEIGHT_PX - scrollTop + 1

  const lineAtClientY = (clientY: number): number | null => {
    const line = Math.floor((clientY - FAKE_EDITOR_TOP_PX + scrollTop) / FAKE_LINE_HEIGHT_PX) + 1
    if (line < 1 || line > lineCount || unresolvable.has(line)) {
      return null
    }
    return line
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the subset of ICodeEditor the diff-comment modules call; every member they reach is implemented below.
  const editor = {
    getDomNode: () => domNode,
    getContainerDomNode: () => domNode,
    getModel: () => model,
    getOption: () => FAKE_LINE_HEIGHT_PX,
    // The gutter-mark hook writes the glyphMargin option through this, and the overlay reads lineHeight.
    updateOptions: () => {},
    getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * FAKE_LINE_HEIGHT_PX,
    getScrollTop: () => scrollTop,
    setScrollTop: (next: number) => {
      scrollTop = next
    },
    getScrollHeight: () => lineCount * FAKE_LINE_HEIGHT_PX,
    getLayoutInfo: () => ({ height: FAKE_EDITOR_HEIGHT_PX, contentLeft: 60 }),
    getSelection: () => null,
    focus: () => {
      focusCount += 1
    },
    deltaDecorations: () => [],
    createDecorationsCollection: (initial?: MonacoEditor.IModelDeltaDecoration[]) => {
      const record: { current: FakeDecoration[] } = { current: [] }
      decorationCollections.add(record)
      const sync = (): void => {
        decorations = [...decorationCollections].flatMap((entry) => entry.current)
      }
      const apply = (next: MonacoEditor.IModelDeltaDecoration[]): void => {
        decorationWrites += 1
        record.current = next.map((decoration) => ({
          startLine: decoration.range.startLineNumber,
          endLine: decoration.range.endLineNumber,
          className: decoration.options.className,
          marginClassName: decoration.options.marginClassName,
          glyphMarginClassName: decoration.options.glyphMarginClassName
        }))
        sync()
      }
      // Monaco takes initial decorations as the argument, not through set() — both styles write here.
      if (initial) {
        apply(initial)
      }
      return {
        set: apply,
        clear: () => {
          decorationWrites += 1
          record.current = []
          sync()
        }
      }
    },
    getTargetAtClientPoint: (clientX: number, clientY: number) => {
      const dead = options.deadColumn
      if (dead && clientX >= dead.fromX && clientX <= dead.toX) {
        return null
      }
      const lineNumber = lineAtClientY(clientY)
      return lineNumber === null
        ? null
        : {
            type: options.gutterTargetType ?? 3 /* GUTTER_LINE_NUMBERS */,
            position: { lineNumber }
          }
    },
    onMouseMove: (listener: (e: { target: { position: { lineNumber: number } } }) => void) => {
      mouseMoveListeners.push(listener)
      return noopDisposable
    },
    onMouseLeave: () => noopDisposable,
    // The gutter-mark hook subscribes to gutter presses through this; the press itself is that
    // hook's own unit suite's subject.
    onMouseDown: () => noopDisposable,
    // Subscriptions the markdown-annotation path takes; nothing here fires them.
    onDidChangeCursorSelection: () => noopDisposable,
    onDidLayoutChange: () => noopDisposable,
    onDidScrollChange: () => noopDisposable,
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener)
      return noopDisposable
    },
    changeViewZones: (callback: (accessor: MonacoEditor.IViewZoneChangeAccessor) => void) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the decorator calls only addZone/removeZone on the accessor, both implemented here.
      callback({
        addZone: (zone: MonacoEditor.IViewZone) => {
          const id = `zone-${(nextZoneId += 1)}`
          zones.set(id, zone)
          return id
        },
        removeZone: (id: string) => {
          zones.delete(id)
        },
        layoutZone: () => {}
      } as unknown as MonacoEditor.IViewZoneChangeAccessor)
  } as unknown as MonacoEditor.ICodeEditor

  return {
    editor,
    domNode,
    zones,
    decorations: () => decorations,
    decorationWrites: () => decorationWrites,
    scrollTop: () => scrollTop,
    focusCount: () => focusCount,
    clientYForLine,
    setLineCount: (next) => {
      lineCount = next
    },
    emitMouseMove: (lineNumber) => {
      for (const listener of mouseMoveListeners) {
        listener({ target: { position: { lineNumber } } })
      }
    },
    emitDispose: () => {
      for (const listener of disposeListeners) {
        listener()
      }
    }
  }
}
