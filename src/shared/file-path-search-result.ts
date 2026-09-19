/**
 * Reply of a query-scoped path search. The host counts every match it scanned and returns
 * a bounded page, so a caller can report a partial result honestly instead of implying the
 * page is the whole answer.
 */
export type FilePathSearchResult = {
  files: string[]
  /** Exact number of matches the host scanned; null when the host cannot count them. */
  totalCount: number | null
  truncated: boolean
}
