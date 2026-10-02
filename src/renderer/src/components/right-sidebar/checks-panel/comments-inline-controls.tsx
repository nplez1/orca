import { MessageSquareOff, MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/**
 * Hides or restores the review threads the code surfaces draw, and explains their absence.
 *
 * The toggle is deliberately one control rather than a hide/show pair: the header has one state to
 * show, and a reader who has hidden the threads needs exactly one way back.
 */
export function CommentsInlineToggle({
  enabled,
  onToggle
}: {
  enabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  const label = enabled
    ? translate(
        'auto.components.right.sidebar.checks.panel.comments.list.38a6c0254e',
        'Hide comments in code'
      )
    : translate(
        'auto.components.right.sidebar.checks.panel.comments.list.a2a5fb7686',
        'Show comments in code'
      )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={onToggle}
        >
          {enabled ? (
            <MessageSquareOff className="size-3" />
          ) : (
            <MessagesSquare className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Why inline comments are missing, shown only when the head rule suppressed them.
 *
 * An unexplained absence reads as a bug, so this names the cause and both commits; the reader can
 * still open any comment from its card, which falls back to the provider in this state.
 */
export function CommentsInlineHeadMismatchNotice({
  worktreeHeadOid,
  commentsHeadSha
}: {
  worktreeHeadOid: string
  commentsHeadSha: string
}): React.JSX.Element {
  return (
    <div className="border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
      <div>
        {translate(
          'auto.components.right.sidebar.checks.panel.comments.list.6b9c7f83c4',
          "Comments are not shown in code because the checked-out commit is not this pull request's head."
        )}
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground/80">
        <div>
          {worktreeHeadOid.slice(0, 7)}{' '}
          {translate(
            'auto.components.right.sidebar.checks.panel.comments.list.c0227ee68e',
            '(checked out)'
          )}
        </div>
        <div>
          {commentsHeadSha.slice(0, 7)}{' '}
          {translate(
            'auto.components.right.sidebar.checks.panel.comments.list.a8502d9752',
            '(pull request head)'
          )}
        </div>
      </div>
    </div>
  )
}
