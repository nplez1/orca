// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import { PR_COMMENT_AI_FIXING_REPLY } from '../pr-comment-fixing-reply-body'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'

type AcknowledgementInput = Parameters<typeof useChecksPanelAiAcknowledgement>[0]

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() }
}))
// Why: the pre-#166 GitLab ack resolved MR discussions through this client, not through the
// GitHub resolver dep — so the spy below cannot catch a GitLab regression on its own.
const gitlab = vi.hoisted(() => ({ resolveGitLabDiscussion: vi.fn(async () => ({ ok: true })) }))
vi.mock('./gitlab-review-client', () => ({
  resolveGitLabMRDiscussionForChecks: gitlab.resolveGitLabDiscussion
}))

const REVIEW_CONTEXT_KEY = 'repo-1::feature::acme/widgets::12::abc123'

function comment(overrides: Partial<PRComment> = {}): PRComment {
  return {
    id: 10,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please rename this.',
    createdAt: '2026-10-20T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/12#discussion_r10',
    threadId: 'T1',
    path: 'src/a.ts',
    line: 4,
    isResolved: false,
    ...overrides
  }
}

/**
 * The payload is deliberately wider than the production type: it keeps the snapshotted resolve
 * targets the pre-#166 ack required. A regression that reintroduces the automatic resolve has to
 * call a resolver with one of them, so the spy assertions below fail against the old behaviour
 * instead of passing merely because the old resolver had no target to work with.
 */
type LegacyAckPayload = PendingPRCommentAiAck & {
  githubResolveTarget: { repoPath: string; repoId: string; prNumber: number }
  gitlabTarget: { repoPath: string; repoId: string; iid: number; ownerHostId: string }
}

function reviewThreadComment(): PRComment {
  return comment()
}

function codeRabbitSummary(): PRComment {
  return comment({
    id: 30,
    author: 'coderabbitai',
    isBot: true,
    body: '## Nitpick comments\n\nOne nit.',
    threadId: undefined,
    path: undefined,
    line: undefined,
    url: 'https://github.com/acme/widgets/pull/12#pullrequestreview-999'
  })
}

/**
 * One open review thread (no host write expected) plus one comment with no resolution endpoint
 * (one acknowledgement reply expected).
 */
function mixedPayload(): LegacyAckPayload {
  return {
    reviewContextKey: REVIEW_CONTEXT_KEY,
    provider: 'github',
    selectedGroups: [
      { kind: 'thread', threadId: 'T1', root: reviewThreadComment(), replies: [] },
      { kind: 'standalone', comment: codeRabbitSummary() }
    ],
    githubTarget: {
      repoPath: '/repos/widgets',
      repoId: 'repo-1',
      prNumber: 12,
      prRepo: { owner: 'acme', repo: 'widgets' }
    },
    githubResolveTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 12 },
    gitlabTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', iid: 12, ownerHostId: 'local' }
  }
}

/**
 * The model is built one prop wider than the hook accepts: before #166 the hook took a
 * `resolveReviewThread` dep and resolved every selected thread after delivery. Supplying one
 * here proves the ack path cannot call it even when a caller still passes it.
 */
function hookInput(overrides: Partial<AcknowledgementInput> = {}) {
  let renderedComments: PRComment[] = [reviewThreadComment(), codeRabbitSummary()]
  const base: AcknowledgementInput = {
    addPRConversationComment: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 99, body: PR_COMMENT_AI_FIXING_REPLY })
    })),
    addPRReviewCommentReply: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 98, body: PR_COMMENT_AI_FIXING_REPLY })
    })),
    asyncResultKeyRef: { current: REVIEW_CONTEXT_KEY },
    claimedCommentResolutionRef: { current: null },
    commentsRef: { current: renderedComments },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef: { current: null },
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: (next: SetStateAction<PRComment[]>) => {
      renderedComments = typeof next === 'function' ? next(renderedComments) : next
    },
    setCommentsSelectionClearRequest: vi.fn(),
    commentResolutionLaunchAcceptedRef: { current: false },
    fetchComments: vi.fn(async () => {}),
    ...overrides
  }
  const resolveReviewThread = vi.fn(async () => true)
  const input: AcknowledgementInput & { resolveReviewThread: typeof resolveReviewThread } = {
    ...base,
    resolveReviewThread
  }
  return {
    input,
    resolveReviewThread,
    renderedComments: (): PRComment[] => renderedComments,
    ...base
  }
}

beforeEach(() => {
  // Why: the pending ack payload is a module-level slot so it survives re-renders; a test that
  // leaves one behind would let the next test ack the wrong review.
  clearPendingPRCommentAiAck()
  gitlab.resolveGitLabDiscussion.mockClear()
  mocks.toastSuccess.mockClear()
  mocks.toastError.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useChecksPanelAiAcknowledgement', () => {
  it('writes nothing when the agent tab opens', () => {
    const model = hookInput()
    const payload = mixedPayload()
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.commentLaunchCallbacks(payload).onLaunchAccepted())

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
  })

  // Why: #166 — the launch used to mark the selected review comments resolved before the agent
  // had done anything. The thread must stay open; the only host write is the reply that the
  // selected comment with no resolution endpoint already got.
  it('leaves the selected thread unresolved on delivery and only replies where it must', async () => {
    const model = hookInput()
    const payload = mixedPayload()
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    const callbacks = result.current.commentLaunchCallbacks(payload)
    act(() => callbacks.onLaunchAccepted())
    act(() => callbacks.onLaunched())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))

    expect(model.input.addPRConversationComment).toHaveBeenCalledWith(
      '/repos/widgets',
      12,
      `@coderabbitai ${PR_COMMENT_AI_FIXING_REPLY}`,
      expect.objectContaining({ repoId: 'repo-1' })
    )
    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    // The rendered list is the user-visible truth: the review thread is still open.
    const threadEntries = model.renderedComments().filter((entry) => entry.threadId === 'T1')
    expect(threadEntries).toContainEqual(expect.objectContaining({ id: 10, isResolved: false }))
    expect(threadEntries.every((entry) => entry.isResolved === false)).toBe(true)
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('left 1 open'))
  })

  // Why: a launch that never delivers is not evidence of anything — writing to the host on the
  // failure path would report work the agent never started.
  it('writes nothing when the launch aborts, and keeps the payload for a retry', () => {
    const model = hookInput()
    const payload = mixedPayload()
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    const callbacks = result.current.commentLaunchCallbacks(payload)
    act(() => callbacks.onLaunchAccepted())
    act(() => callbacks.onLaunchAborted())

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(model.pendingCommentResolutionRef.current).toBe(payload)
  })

  // Why: GitLab MR discussions have no reply endpoint here, so the ack must not touch the host
  // at all — the toast counts tell the user the threads are theirs to close.
  it('writes nothing on a provider without a reply endpoint', async () => {
    const model = hookInput()
    const payload = {
      ...mixedPayload(),
      provider: 'gitlab',
      githubTarget: undefined
    } as NonNullable<typeof model.pendingCommentResolutionRef.current>
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    const callbacks = result.current.commentLaunchCallbacks(payload)
    act(() => callbacks.onLaunchAccepted())
    act(() => callbacks.onLaunched())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(gitlab.resolveGitLabDiscussion).not.toHaveBeenCalled()
    expect(model.renderedComments().every((entry) => entry.isResolved !== true)).toBe(true)
  })

  // Why: an open-thread selection on a PR whose repo could not be resolved writes nothing, but
  // the launch itself succeeded — that is a success toast, not an error.
  it('reports a thread-only selection with no reply target as a success', async () => {
    const model = hookInput()
    const payload = {
      ...mixedPayload(),
      selectedGroups: [
        { kind: 'thread', threadId: 'T1', root: reviewThreadComment(), replies: [] }
      ],
      githubTarget: undefined
    } as NonNullable<typeof model.pendingCommentResolutionRef.current>
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    const callbacks = result.current.commentLaunchCallbacks(payload)
    act(() => callbacks.onLaunchAccepted())
    act(() => callbacks.onLaunched())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
  })

  it('reports a missing GitHub reply target instead of claiming success', async () => {
    const model = hookInput()
    const payload = {
      ...mixedPayload(),
      githubTarget: undefined
    } as NonNullable<typeof model.pendingCommentResolutionRef.current>
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    const callbacks = result.current.commentLaunchCallbacks(payload)
    act(() => callbacks.onLaunchAccepted())
    act(() => callbacks.onLaunched())
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
