import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function SourceControlHeaderIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  'data-link-url': linkUrl
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  /** Set when the action opens this address, so the app's link menu can offer it too. */
  'data-link-url'?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          data-link-url={linkUrl}
          onClick={onClick}
          disabled={disabled}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
