import type React from 'react'

/** A composer value the flow fixed for the user: shown where the input would be, not editable. */
export function LockedComposerValue({ value }: { value: string }): React.JSX.Element {
  return (
    <div className="flex h-9 items-center rounded-md border border-input bg-muted/35 px-3 text-sm">
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}
