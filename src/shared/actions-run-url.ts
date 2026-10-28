/**
 * The workflow run a check's link belongs to, or undefined when the link is not an Actions run.
 *
 * Shared because both sides of the rerun decision need it: the main process selects the runs to
 * POST, and the renderer has to know whether a check is the GitHub half of a mixed failure list
 * before it asks GitHub at all.
 */
export function parseActionsRunId(url: string | null | undefined): number | undefined {
  if (!url) {
    return undefined
  }
  const match = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url)
  if (!match) {
    return undefined
  }
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}
