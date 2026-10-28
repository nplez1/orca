import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useProjectHostSetupProjection } from '@/store/selectors'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getProjectHostSetupsForProject } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildSetupHostOptions,
  type SetupHostOption
} from '@/components/settings/repository/execution/repository-host-setup-options'
import { getRepositoryHostSetupsSectionId } from '@/components/settings/repository/repository-settings-targets'
import { useConfiguredExecutionHostOptions } from '@/hooks/use-configured-execution-host-options'

export type ProjectAddToHostActions = {
  /** Hosts this project can still be added to; empty means the menu has nothing to offer. */
  getAddToHostOptions: (repo: Repo) => readonly SetupHostOption[]
  addToHost: (repo: Repo, hostId: ExecutionHostId) => void
}

/**
 * The sidebar half of "add this project to another host": the same eligible-host list
 * Settings → Available Hosts computes, and a deep link into that section's add flow.
 * Adding is never reimplemented here — the store request only preselects the host.
 */
export function useProjectAddToHost(): ProjectAddToHostActions {
  const hostOptions = useConfiguredExecutionHostOptions()
  const projection = useProjectHostSetupProjection()
  const requestProjectHostAdd = useAppStore((state) => state.requestProjectHostAdd)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)

  // Why: one list per project, so a menu opened on any of its checkouts shows the same hosts.
  const optionsByProjectId = useMemo(() => {
    const byProjectId = new Map<string, SetupHostOption[]>()
    for (const setup of projection.setups) {
      if (byProjectId.has(setup.projectId)) {
        continue
      }
      byProjectId.set(
        setup.projectId,
        buildSetupHostOptions({
          projectHostSetups: getProjectHostSetupsForProject(projection.setups, setup.projectId),
          hostOptions
        })
      )
    }
    return byProjectId
  }, [hostOptions, projection])

  const projectIdForRepo = useCallback(
    (repo: Repo): string | null =>
      // Why: the same rule Settings uses to pick a project's pane — the repo row names the
      // project, so a row with no setup offering hosts instead would dead-end the deep link.
      projection.setups.find((setup) => setup.repoId === repo.id)?.projectId ?? null,
    [projection]
  )

  const getAddToHostOptions = useCallback(
    (repo: Repo): readonly SetupHostOption[] => {
      if (!isGitRepoKind(repo)) {
        return []
      }
      const projectId = projectIdForRepo(repo)
      return projectId ? (optionsByProjectId.get(projectId) ?? []) : []
    },
    [optionsByProjectId, projectIdForRepo]
  )

  const addToHost = useCallback(
    (repo: Repo, hostId: ExecutionHostId) => {
      const projectId = projectIdForRepo(repo)
      if (!projectId) {
        return
      }
      requestProjectHostAdd({ projectId, repoId: repo.id, hostId })
      openSettingsTarget({
        pane: 'repo',
        repoId: repo.id,
        sectionId: getRepositoryHostSetupsSectionId(repo.id),
        // Why: twin repo ids and same-host duplicates need the exact setup, or the pane opens elsewhere.
        hostId: getRepoExecutionHostId(repo)
      })
      openSettingsPage()
    },
    [openSettingsPage, openSettingsTarget, projectIdForRepo, requestProjectHostAdd]
  )

  return { getAddToHostOptions, addToHost }
}
