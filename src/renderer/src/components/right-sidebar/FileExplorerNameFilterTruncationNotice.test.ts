import { describe, expect, it } from 'vitest'
import { FileExplorerNameFilterTruncationNotice } from './FileExplorerNameFilterTruncationNotice'

describe('FileExplorerNameFilterTruncationNotice', () => {
  it('says how many matches were found and how many are shown', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 5_000,
      totalCount: 182_311
    })

    expect(element.props.children).toBe(
      `Showing the first ${(5_000).toLocaleString()} of ${(182_311).toLocaleString()} matches — add more of the name to narrow it down`
    )
  })

  it('never claims a count the host could not provide', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 5_000,
      totalCount: null
    })

    expect(element.props.children).toBe(
      'Only part of this workspace was searched — add more of the name to narrow it down'
    )
  })
})
