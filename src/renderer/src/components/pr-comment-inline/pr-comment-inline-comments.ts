import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'
import type { PRCommentInlineThread } from './pr-comment-inline-threads'

/**
 * Namespaces PR review threads away from a worktree's own local notes.
 *
 * A review thread is not part of the worktree's note store, and two PRs can carry the same comment
 * ids, so the scope has to include both the repository and the pull request.
 */
export function getPRCommentInlineScope(repoId: string, prNumber: number): string {
  return `github-pr:${repoId}:${prNumber}`
}

/** Compare repo-relative paths without caring which separator the caller used. */
export function normalizePRCommentPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Projects review threads into the shape the inline-comment zone decorator renders.
 *
 * `filePath` is forced to the caller's own spelling of the path: the decorator matches its
 * comments against the exact `filePath` it was given, so a comment carrying GitHub's separator must
 * adopt the editor's rather than be filtered out.
 */
export function toInlinePRComments(args: {
  threads: readonly PRCommentInlineThread[]
  scope: string
  filePath: string
}): DecoratedDiffComment[] {
  return args.threads.map((thread) => {
    const createdAtMs = new Date(thread.root.createdAt).getTime()
    return {
      id: thread.id,
      worktreeId: args.scope,
      filePath: args.filePath,
      source: 'diff',
      startLine: thread.startLine,
      lineNumber: thread.line,
      body: thread.root.body,
      createdAt: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      side: 'modified',
      author: thread.root.author,
      authorAvatarUrl: thread.root.authorAvatarUrl,
      createdAtLabel: formatRelativeTime(thread.root.createdAt),
      url: thread.root.url,
      isBot: thread.root.isBot,
      canDelete: false,
      canEdit: false,
      thread: {
        threadId: thread.threadId,
        rootCommentId: thread.root.id,
        replies: thread.replies,
        isResolved: thread.isResolved
      }
    }
  })
}
