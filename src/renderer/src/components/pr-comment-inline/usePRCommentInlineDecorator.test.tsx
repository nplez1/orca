// @vitest-environment happy-dom

import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DiffCommentZoneCardModule from '../diff-comments/diff-comment-zone-card'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { PRCommentInlineThread } from './pr-comment-inline-threads'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))

// Stub only the card render: this suite is about which gutter slot a line claims, not card markup.
vi.mock('../diff-comments/diff-comment-zone-card', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffCommentZoneCardModule>()),
  renderDiffCommentZoneCard: vi.fn()
}))

// The decorator pair keeps its display state in the store, and the surfaces that mount both of them
// are what this suite reproduces — so the store is a fixture the test can flip, not a real store.
const storeFixture = vi.hoisted(() => {
  const activeGroupIdByWorktree: Record<string, string> = {}
  const prCommentInlineDisplayById: Record<string, 'expanded' | 'collapsed'> = {}
  return {
    activeGroupIdByWorktree,
    clearDeliveredDiffComments: vi.fn(),
    prCommentInlineDisplayById,
    setPRCommentInlineDisplay: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

import { usePRCommentInlineDecorator } from './usePRCommentInlineDecorator'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { getPRCommentInlineId } from './pr-comment-inline-threads'
import {
  createFakeDiffCommentEditor,
  type FakeDiffCommentEditor
} from '../diff-comments/diff-comment-editor-test-fixture'

const FILE_PATH = 'src/index.ts'
const SCOPE = 'github-pr:acme/widgets:42'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  // Why: display overrides outlive a test, and a leftover one would decide the next test's render.
  for (const id of Object.keys(storeFixture.prCommentInlineDisplayById)) {
    delete storeFixture.prCommentInlineDisplayById[id]
  }
  vi.clearAllMocks()
})

function reviewThread(line: number): PRCommentInlineThread {
  const root: PRComment = {
    id: 1000 + line,
    author: 'octocat',
    authorAvatarUrl: '',
    body: 'This reads better as a loop.',
    createdAt: '2026-10-01T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#discussion_r${1000 + line}`,
    path: FILE_PATH,
    threadId: `thread-${line}`,
    isResolved: false,
    line
  }
  return {
    id: getPRCommentInlineId(root.id),
    threadId: root.threadId,
    path: FILE_PATH,
    line,
    isResolved: false,
    root,
    replies: []
  }
}

/**
 * The add-note "+" buttons this editor holds, in DOM order.
 *
 * More than one exists on a surface that mounts both decorators: the review-thread decorator
 * installs its own overlay with an empty commentable set, which never shows. Counting the visible
 * ones is what "one affordance per line" actually means.
 */
function addedButtons(domNode: HTMLElement): HTMLElement[] {
  return [...domNode.querySelectorAll<HTMLElement>('.orca-diff-comment-add-btn')]
}

function visibleAddButtonCount(domNode: HTMLElement): number {
  return addedButtons(domNode).filter((button) => button.style.display !== 'none').length
}

/**
 * The wiring both real surfaces use (DiffViewer, DiffSectionItem): the thread decorator first, so the
 * line it marks as a gutter bubble can be withheld from the note decorator's "+".
 */
function GutterSurface({
  fake,
  threads,
  enabled
}: {
  fake: FakeDiffCommentEditor
  threads: readonly PRCommentInlineThread[]
  enabled: boolean
}): null {
  const threadGutter = usePRCommentInlineDecorator({
    editor: fake.editor,
    filePath: FILE_PATH,
    threads,
    scope: SCOPE,
    enabled
  })
  useDiffCommentDecorator({
    editor: fake.editor,
    filePath: FILE_PATH,
    worktreeId: 'worktree-1',
    comments: [],
    // The worktree diff tab passes no commentable lines, which the overlay reads as "every line is".
    gutterOccupiedLineNumbers: threadGutter.gutterOccupiedLines,
    onAddCommentClick: vi.fn(),
    onDeleteComment: vi.fn()
  })
  return null
}

describe('usePRCommentInlineDecorator gutter ownership', () => {
  it('reports a collapsed thread as owning its line, and releases the line when it opens', () => {
    const thread = reviewThread(40)
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePRCommentInlineDecorator({
          editor: null,
          filePath: FILE_PATH,
          threads: [thread],
          scope: SCOPE,
          enabled
        }),
      { initialProps: { enabled: false } }
    )

    expect(hook.result.current.gutterOccupiedLines).toEqual([40])

    // Expanded inline: the line carries the thread card instead of a bubble, so nothing occupies it.
    hook.rerender({ enabled: true })
    expect(hook.result.current.gutterOccupiedLines).toEqual([])
  })

  it('reports no occupied lines for a file with no review threads', () => {
    const hook = renderHook(() =>
      usePRCommentInlineDecorator({
        editor: null,
        filePath: FILE_PATH,
        threads: null,
        scope: null,
        enabled: true
      })
    )

    expect(hook.result.current.gutterOccupiedLines).toEqual([])
  })

  it('offers exactly one affordance on a commented line, and the "+" again on the lines around it', () => {
    const fake = createFakeDiffCommentEditor()
    const threads = [reviewThread(40)]
    render(<GutterSurface fake={fake} threads={threads} enabled={false} />)

    // The bubble is really there — "no "+" on this line" is only meaningful next to it.
    expect(fake.decorations()).toContainEqual({
      startLine: 40,
      endLine: 40,
      className: undefined,
      marginClassName: undefined,
      glyphMarginClassName: 'orca-pr-comment-gutter-mark'
    })

    // The defect this pins: hovering a line with a collapsed thread used to offer "add a note" and
    // hide "there is a conversation here", and the "+" swallowed the click meant for the bubble.
    fake.emitMouseMove(40)
    expect(visibleAddButtonCount(fake.domNode)).toBe(0)

    fake.emitMouseMove(41)
    expect(visibleAddButtonCount(fake.domNode)).toBe(1)
  })

  it('keeps the running "+" instead of rebuilding it when a thread opens', () => {
    const fake = createFakeDiffCommentEditor()
    const threads = [reviewThread(40)]
    const { rerender } = render(<GutterSurface fake={fake} threads={threads} enabled={false} />)
    const parked = addedButtons(fake.domNode)[1]
    expect(parked).toBeDefined()

    // Why: the occupied-line set is derived from the thread list, so it changes whenever any thread
    // is toggled or comments are refetched. Reinstalling the overlay for that would re-park the
    // button under a stationary pointer and drop a gutter drag in flight.
    rerender(<GutterSurface fake={fake} threads={threads} enabled />)
    expect(addedButtons(fake.domNode)[1]).toBe(parked)

    // Nothing left to collide with, so the "+" is back on the line the thread used to own.
    fake.emitMouseMove(40)
    expect(visibleAddButtonCount(fake.domNode)).toBe(1)
  })
})
