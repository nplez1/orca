import { ImeTextarea } from '@/lib/ime-text-field'
import React, { useCallback, useEffect, useRef } from 'react'
import { Bold, Code2, Italic, List, LoaderCircle, Quote, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { cn } from '@/lib/utils'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { applyMarkdownAction, type MarkdownAction } from '@/lib/comment-markdown-actions'
import {
  clearCommentComposerFocusTimer,
  scheduleCommentComposerFocusTimer
} from '@/lib/comment-composer-focus-timer'
import { translate } from '@/i18n/i18n'

export type CommentComposerProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  /** Names the send button for assistive tech and for its tooltip. */
  submitLabel: string
  /** Whether `value` holds something the provider will accept. */
  canSubmit: boolean
  submitting?: boolean
  disabled?: boolean
  disabledReason?: string
  className?: string
}

/** The composer an issue or pull-request reply is typed into: a bordered bubble
 *  whose input grows with the text and whose footer row carries the markdown
 *  controls on the left and an icon-only send action on the right.
 *
 *  Provider-agnostic on purpose — the issue pane, the Tasks view, and the PR
 *  comment reply all want this one layout, so the provider supplies the copy and
 *  the submit handler while the editing behaviour stays here. */
export function CommentComposer({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  submitLabel,
  canSubmit,
  submitting = false,
  disabled = false,
  disabledReason,
  className
}: CommentComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMac = navigator.userAgent.includes('Mac')
  const locked = disabled || submitting

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    // Why: measured from zero so a shorter value shrinks the field back down
    // instead of only ever growing it.
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }, [value])

  useEffect(
    () => () => {
      // Why: the restore callback outlives a composer that unmounts between the
      // click and its timer, and would then focus a detached textarea.
      clearCommentComposerFocusTimer(selectionTimerRef)
    },
    []
  )

  const applyAction = useCallback(
    (action: MarkdownAction) => {
      const textarea = textareaRef.current
      if (!textarea) {
        return
      }
      const next = applyMarkdownAction(
        value,
        textarea.selectionStart,
        textarea.selectionEnd,
        action
      )
      onValueChange(next.value)
      scheduleCommentComposerFocusTimer(selectionTimerRef, () => {
        if (!textarea.isConnected) {
          return
        }
        textarea.focus()
        textarea.setSelectionRange(next.selectionStart, next.selectionEnd)
      })
    },
    [onValueChange, value]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Why: the Enter that only confirms a CJK candidate still reports the held
      // modifier, so submitting here would post the text without its last syllable.
      if (isImeCompositionKeyDown(event)) {
        return
      }
      if (event.key !== 'Enter' || !(isMac ? event.metaKey : event.ctrlKey)) {
        return
      }
      event.preventDefault()
      if (canSubmit && !locked) {
        onSubmit()
      }
    },
    [canSubmit, isMac, locked, onSubmit]
  )

  const toolbar: { action: MarkdownAction; label: string; icon: typeof Bold }[] = [
    {
      action: 'bold',
      label: translate('auto.components.comment.composer.f3e93f1b3a', 'Bold'),
      icon: Bold
    },
    {
      action: 'italic',
      label: translate('auto.components.comment.composer.705066a871', 'Italic'),
      icon: Italic
    },
    {
      action: 'code',
      label: translate('auto.components.comment.composer.20fc7f3d3d', 'Code'),
      icon: Code2
    },
    {
      action: 'quote',
      label: translate('auto.components.comment.composer.96d2a26262', 'Quote'),
      icon: Quote
    },
    {
      action: 'list',
      label: translate('auto.components.comment.composer.564c4d0787', 'List'),
      icon: List
    }
  ]

  return (
    <div
      className={cn(
        // Why the ring lives on the bubble: the textarea is borderless inside it, so
        // a focus ring on the field itself would draw a rounded box mid-surface.
        'min-w-0 overflow-hidden rounded-md border border-border bg-background',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        className
      )}
    >
      <ImeTextarea
        ref={textareaRef}
        value={value}
        rows={2}
        className="block max-h-40 min-h-9 w-full min-w-0 resize-none bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={placeholder}
        disabled={locked}
        title={disabled ? disabledReason : undefined}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {/* Why one row: formatting and the send action belong to the same editing
          surface, so the controls sit inside the bubble's own footer rather than
          in a bar below it. */}
      <div className="flex min-w-0 items-center gap-0.5 px-1.5 pb-1.5">
        {toolbar.map(({ action, label, icon: Icon }) => (
          <Tooltip key={action}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                disabled={locked}
                onClick={() => applyAction(action)}
              >
                <Icon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why a plain button: the primitive's sizes are rounded rectangles, and
                the send action is a circle that owns its own shape. */}
            <button
              type="button"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              aria-label={submitLabel}
              disabled={locked || !canSubmit}
              onClick={onSubmit}
            >
              {submitting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disabled && disabledReason ? (
              <span>{disabledReason}</span>
            ) : (
              <span className="flex items-center gap-2">
                <span>{submitLabel}</span>
                <ShortcutKeyCombo
                  keys={[isMac ? '⌘' : 'Ctrl', 'Enter']}
                  className="shrink text-[10px] [&_span]:min-w-0 [&_span]:px-1"
                  separatorClassName="mx-0 text-[10px] text-muted-foreground"
                />
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
