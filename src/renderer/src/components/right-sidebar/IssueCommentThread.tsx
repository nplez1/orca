import { LoaderCircle, RefreshCw } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'

/** One comment, normalized across Jira / Linear / GitHub. */
export type IssueCommentView = {
  id: string
  authorName: string
  authorAvatarUrl?: string | null
  createdAt: string
  body: string
}

function CommentAvatar({
  name,
  avatarUrl
}: {
  name: string
  avatarUrl?: string | null
}): React.JSX.Element {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
  }
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

/** Compact comment thread for the narrow Issue pane: avatar, author, relative
 *  time, and markdown body per comment. Shared by all three provider panes. */
export function IssueCommentThread({
  comments,
  loading,
  error,
  onRetry
}: {
  comments: IssueCommentView[]
  loading: boolean
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.right.sidebar.IssueComments.title', 'Comments')}
          </span>
          {comments.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">{comments.length}</span>
          ) : null}
        </div>
        {error ? (
          <Button variant="outline" size="xs" onClick={onRetry} disabled={loading}>
            {loading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.right.sidebar.IssueComments.retry', 'Retry')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : loading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.right.sidebar.IssueComments.empty', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <CommentAvatar name={comment.authorName} avatarUrl={comment.authorAvatarUrl} />
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {comment.authorName}
                </span>
                {comment.createdAt ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {formatUiRelativeTimeFromDate(comment.createdAt)}
                  </span>
                ) : null}
              </div>
              <div className="px-3 py-2">
                {/* Why: comment screenshots need the same preview affordance as the Task view. */}
                <CommentMarkdown
                  content={comment.body}
                  expandImages
                  className="text-[13px] leading-relaxed"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
