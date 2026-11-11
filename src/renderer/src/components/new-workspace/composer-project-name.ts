import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

/**
 * The name a project is shown by in the composer, shared by the surfaces that name it.
 *
 * The project's own display name wins; without one, the selected repo's name stands in, so a clone
 * or a setup on another host still has a name to write on the host.
 */
export function resolveComposerProjectName({
  projectOptions,
  selectedProjectId,
  eligibleRepos,
  repoId
}: {
  projectOptions: readonly NewWorkspaceProjectOption[]
  selectedProjectId: string | null
  eligibleRepos: readonly { id: string; displayName?: string; path?: string }[]
  repoId: string
}): string {
  const selectedRepo = eligibleRepos.find((candidate) => candidate.id === repoId)
  const repoName = selectedRepo?.displayName ?? selectedRepo?.path ?? 'This project'
  return (
    projectOptions.find((candidate) => candidate.id === selectedProjectId)?.displayName ?? repoName
  )
}
