import React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type RichMarkdownToolbarButtonProps = {
  active: boolean
  label: string
  /** Set only by callers that track the toggle's own state. Left undefined, the
   *  button announces no pressed state at all — which is correct for the
   *  document toolbar, whose buttons are actions, not toggles. */
  pressed?: boolean
  /** Sits in a narrow surface (a sidebar bubble) where the toolbar's default
   *  28px buttons would not fit a full row. */
  compact?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

export function RichMarkdownToolbarButton({
  active,
  label,
  pressed,
  compact = false,
  disabled = false,
  onClick,
  children
}: RichMarkdownToolbarButtonProps): React.JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'rich-markdown-toolbar-button',
              compact && 'is-compact',
              active && 'is-active'
            )}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
