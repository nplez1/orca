import { RuntimeClientError } from '../runtime-client'
import { getWorkspaceKeyParentSelector } from './worktree-create-parent-selector'

export function assertWorktreeSetParentIsNotFolder(parentSelector: string | undefined): void {
  if (parentSelector && getWorkspaceKeyParentSelector(parentSelector)?.startsWith('folder:')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Parent selector "${parentSelector}" is a folder. Folder parents are accepted only by orca worktree create.`
    )
  }
}

// worktree.set reports selector_not_found without naming which of its two selectors missed.
export function worktreeSetSelectorNextSteps(
  worktree: string,
  parentSelector: string | undefined
): string[] {
  return parentSelector
    ? [
        `Orca could not find the worktree selector "${worktree}" or the parent selector "${parentSelector}". The server did not identify which selector failed.`,
        'Check both selectors with orca worktree show --worktree <selector> --json.'
      ]
    : []
}
