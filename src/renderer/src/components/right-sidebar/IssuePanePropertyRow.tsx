import React, { forwardRef } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One compact property row for the narrow Issue pane: label left, value right.
 *
 *  Renders a `<button>` and forwards its ref so it can serve as a
 *  `PopoverTrigger asChild` target. `value` may be a node (avatar + name). */
export const IssuePanePropertyRow = forwardRef<
  HTMLButtonElement,
  {
    label: string
    value: React.ReactNode
    leading?: React.ReactNode
    pending?: boolean
    /** Row opens a popover; the caret signals that. Read-only rows pass false. */
    withChevron?: boolean
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'>
>(function IssuePanePropertyRow(
  { label, value, leading, pending = false, withChevron = true, className, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition',
        'hover:bg-accent disabled:pointer-events-none disabled:opacity-60',
        className
      )}
      {...props}
    >
      <span className="w-[68px] shrink-0 truncate text-[11px] text-muted-foreground">{label}</span>
      {leading}
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{value}</span>
      {pending ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {withChevron ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </button>
  )
})
