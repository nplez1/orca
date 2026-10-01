import React from 'react'
import { GripVertical } from 'lucide-react'

/**
 * Window-move target that lives outside the tab strip, so the floating panel can always be
 * dragged. Once enough tabs fill the strip, every press in the titlebar lands on a sortable
 * tab (a no-drag target) and the panel becomes immovable; this fixed-width handle keeps a
 * reliable grab area at the far left. Must stay a plain div — `button` is a no-drag selector.
 */
export function FloatingTerminalTitlebarGrabHandle(): React.JSX.Element {
  return (
    <div
      data-floating-terminal-drag-handle
      aria-hidden="true"
      className="flex h-full w-6 shrink-0 cursor-grab items-center justify-center border-r border-border text-muted-foreground/50 transition-colors hover:text-muted-foreground active:cursor-grabbing"
    >
      <GripVertical className="size-3.5" />
    </div>
  )
}
