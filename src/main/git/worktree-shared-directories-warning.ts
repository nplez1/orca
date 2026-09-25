const MAX_SHARED_DIRECTORY_FAILURES_IN_WARNING = 5

export function formatWorktreeSharedDirectoriesWarning(
  failedPaths: readonly string[]
): string | undefined {
  if (failedPaths.length === 0) {
    return undefined
  }
  const shown = failedPaths.slice(0, MAX_SHARED_DIRECTORY_FAILURES_IN_WARNING)
  const listedPaths = shown.map((path) => `"${path}"`).join(', ')
  const remaining = failedPaths.length - shown.length
  const suffix = remaining > 0 ? ` and ${remaining} more` : ''
  const noun = failedPaths.length === 1 ? 'path' : 'paths'
  return `Could not materialize worktree.sharedDirectories ${noun}: ${listedPaths}${suffix}. See the app logs for details.`
}
