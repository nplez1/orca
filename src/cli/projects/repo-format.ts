import { branchRefLabels } from '../../shared/git/refs/branch-ref-label'
import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs
} from '../../shared/worktree/catalog/runtime-worktree-contracts'

export function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  const lines = result.repos.map(
    (repo) =>
      `${repo.id}  ${repo.displayName}  ${repo.path}${typeof repo.hiddenAt === 'number' ? '  (hidden)' : ''}`
  )
  // Why a trailing hint rather than a column: a relocation is rare and actionable, and the cue
  // belongs next to the command that acts on it.
  const needsRelocation = new Set(result.relocationRequiredRepoIds ?? [])
  for (const repo of result.repos) {
    if (needsRelocation.has(repo.id)) {
      lines.push(
        `\n${repo.id} is not in its project folder. Run: orca repo relocate --repo ${repo.id}`
      )
    }
  }
  return lines.join('\n')
}

export function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

export function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  const labels = branchRefLabels(result.refs)
  const text = result.refs.map((ref) => labels.get(ref) ?? ref).join('\n')
  return result.truncated ? `${text}\n\ntruncated: yes` : text
}
