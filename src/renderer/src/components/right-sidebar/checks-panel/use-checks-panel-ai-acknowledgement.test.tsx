// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function reviewThreadPayload(): PendingPRCommentAiAck {
  return {
    reviewContextKey: REVIEW_CONTEXT_KEY,
    provider: 'github',
    selectedGroups: [
      {
        kind: 'thread',
        threadId: 'T1',
        root: comment(),
        replies: []
      }
    ],
    githubTarget: {
      repoPath: '/repos/widgets',
      repoId: 'repo-1',
      prNumber: 12,
      prRepo: { owner: 'acme', repo: 'widgets' }
    }
  }
}

/**
 * The model is deliberately built one prop wider than the hook accepts: before #166 the hook
 * took a `resolveReviewThread` dep and resolved every selected thread after delivery. Passing
 * one here proves the ack path cannot call it even when a caller supplies it.
 */
function hookInput(overrides: Partial<AcknowledgementInput> = {}) {
  const base: AcknowledgementInput = {
    addPRConversationComment: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 99 })
    })),
    addPRReviewCommentReply: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 98, body: PR_COMMENT_AI_FIXING_REPLY })
    })),
    asyncResultKeyRef: { current: REVIEW_CONTEXT_KEY },
    claimedCommentResolutionRef: { current: null },
    commentsRef: { current: [comment()] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef: { current: null },
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
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
  return { input, resolveReviewThread, ...base }
}

beforeEach(() => {
  // Why: the pending ack payload is a module-level slot so it survives re-renders; a test that
  // leaves one behind would let the next test ack the wrong review.
  clearPendingPRCommentAiAck()
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
    model.pendingCommentResolutionRef.current = reviewThreadPayload()
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.handleLaunchAccepted())

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
  })

  // Why: #166 — delivery used to mark the selected review comments resolved, before the agent
  // had done anything. The thread must stay open; only the fixing reply may reach the host.
  it('replies in the selected thread on delivery without resolving it', async () => {
    const model = hookInput()
    model.pendingCommentResolutionRef.current = reviewThreadPayload()
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.handleLaunchAccepted())
    act(() => result.current.consumeClaimedCommentResolutionAfterDeliveryRef.current())
    await waitFor(() =>
      expect(model.input.addPRReviewCommentReply).toHaveBeenCalledWith(
        '/repos/widgets',
        12,
        10,
        PR_COMMENT_AI_FIXING_REPLY,
        expect.objectContaining({ repoId: 'repo-1', threadId: 'T1', path: 'src/a.ts' })
      )
    )
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('stay unresolved'))
  })

  // Why: a launch that never delivers is not evidence of anything — posting a reply (or any
  // review-state change) on the failure path would misreport work the agent never started.
  it('writes nothing when the launch aborts, and keeps the payload for a retry', () => {
    const model = hookInput()
    const payload = reviewThreadPayload()
    model.pendingCommentResolutionRef.current = payload
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.handleLaunchAccepted())
    act(() => result.current.handleLaunchAborted())

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(model.pendingCommentResolutionRef.current).toBe(payload)
  })

  // Why: GitLab MR discussions have no reply endpoint here, so the ack must not touch the
  // host at all — the counts tell the user the threads are theirs to close.
  it('writes nothing on a provider without a reply endpoint', async () => {
    const model = hookInput()
    model.pendingCommentResolutionRef.current = {
      ...reviewThreadPayload(),
      provider: 'gitlab',
      githubTarget: undefined
    }
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.handleLaunchAccepted())
    act(() => result.current.consumeClaimedCommentResolutionAfterDeliveryRef.current())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.input.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
  })

  it('reports a missing GitHub reply target instead of claiming success', async () => {
    const model = hookInput()
    model.pendingCommentResolutionRef.current = {
      ...reviewThreadPayload(),
      githubTarget: undefined
    }
    const { result } = renderHook(() => useChecksPanelAiAcknowledgement(model.input))

    act(() => result.current.handleLaunchAccepted())
    act(() => result.current.consumeClaimedCommentResolutionAfterDeliveryRef.current())
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))

    expect(model.input.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
