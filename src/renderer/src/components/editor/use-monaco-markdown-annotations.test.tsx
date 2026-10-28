// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor as monacoEditor } from 'monaco-editor'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))

// This suite is about forwarding a line filter, not about which notes a worktree holds.
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => []
}))

const storeFixture = vi.hoisted(() => {
  const activeGroupIdByWorktree: Record<string, string> = {}
  return {
    activeGroupIdByWorktree,
    addDiffComment: vi.fn(),
    clearDeliveredDiffComments: vi.fn(),
    deleteDiffComment: vi.fn(),
    scrollToDiffCommentId: null,
    setScrollToDiffCommentId: vi.fn(),
    updateDiffComment: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

import { useMonacoMarkdownAnnotations } from './use-monaco-markdown-annotations'
import {
  createFakeDiffCommentEditor,
  type FakeDiffCommentEditor
} from '../diff-comments/diff-comment-editor-test-fixture'

function visibleAddButtonCount(domNode: HTMLElement): number {
  return [...domNode.querySelectorAll<HTMLElement>('.orca-diff-comment-add-btn')].filter(
    (button) => button.style.display !== 'none'
  ).length
}

/**
 * The plain editor's own wiring: this hook mounts the add-note "+" on the same editor that
 * `MonacoEditor` mounts collapsed review-thread bubbles on, so the lines it is handed are what
 * keeps a markdown file from showing two controls in one gutter slot.
 */
function Harness({
  fake,
  gutterOccupiedLineNumbers
}: {
  fake: FakeDiffCommentEditor
  gutterOccupiedLineNumbers: readonly number[]
}): null {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useMonacoMarkdownAnnotations({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every ICodeEditor member this hook's decorator reaches; the standalone interface only adds members no path here calls.
    mountedEditor: fake.editor as unknown as monacoEditor.IStandaloneCodeEditor,
    editorContainerRef: containerRef,
    relativePath: 'notes.md',
    content: '# Title',
    language: 'markdown',
    worktreeId: 'worktree-1',
    markdownAnnotationsEnabled: true,
    gutterOccupiedLineNumbers
  })
  return null
}

beforeEach(() => {
  storeFixture.scrollToDiffCommentId = null
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useMonacoMarkdownAnnotations', () => {
  it('keeps the "+" off the lines a collapsed review thread owns', () => {
    const fake = createFakeDiffCommentEditor()
    const threadLines: readonly number[] = [40]
    const { rerender } = renderHook(
      ({ lines }: { lines: readonly number[] }) =>
        Harness({ fake, gutterOccupiedLineNumbers: lines }),
      { initialProps: { lines: threadLines } }
    )

    fake.emitMouseMove(40)
    expect(visibleAddButtonCount(fake.domNode)).toBe(0)

    fake.emitMouseMove(41)
    expect(visibleAddButtonCount(fake.domNode)).toBe(1)

    // The filter is the parameter, not a blanket suppression of the "+" on this surface.
    rerender({ lines: [] })
    fake.emitMouseMove(40)
    expect(visibleAddButtonCount(fake.domNode)).toBe(1)
  })
})
