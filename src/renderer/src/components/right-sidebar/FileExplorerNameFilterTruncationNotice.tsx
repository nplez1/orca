import React from 'react'
import { translate } from '@/i18n/i18n'

/**
 * Why: a bounded result page must never read as the complete set. The host counts every
 * match it scanned, so say how many were found and how many are on screen.
 */
export function FileExplorerNameFilterTruncationNotice({
  shownCount,
  totalCount
}: {
  shownCount: number
  totalCount: number | null
}): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {totalCount === null
        ? translate(
            'auto.components.right.sidebar.FileExplorer.filterScannedPartialWorkspace',
            'Only part of this workspace was searched — add more of the name to narrow it down'
          )
        : translate(
            'auto.components.right.sidebar.FileExplorer.filterShowingFirstMatches',
            'Showing the first {{value0}} of {{value1}} matches — add more of the name to narrow it down',
            // Why: grouped counts follow the number formatting used by other count banners.
            { value0: shownCount.toLocaleString(), value1: totalCount.toLocaleString() }
          )}
    </p>
  )
}
