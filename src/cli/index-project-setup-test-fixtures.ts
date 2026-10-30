import { PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY } from '../shared/worktree-runtime-capabilities'
import { okFixture } from './test-fixtures'

export const ORCA_PROJECT = {
  id: 'github:stablyai/orca',
  displayName: 'Orca',
  badgeColor: '#7c3aed',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

export const PROJECT_LIST_FIXTURE = okFixture('req_project_list', { projects: [ORCA_PROJECT] })

/** A ready legacy-repo setup of ORCA_PROJECT, as `project setups` lists it. */
export function legacyProjectSetup(setup: {
  id: string
  hostId: string
  repoId: string
  path: string
  displayName?: string
}) {
  return {
    projectId: ORCA_PROJECT.id,
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...setup
  }
}

export function hostTargetStatusFixture(supported: boolean) {
  return okFixture('req_status', {
    capabilities: supported ? [PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY] : []
  })
}

/** A `projectHostSetup.create|update` answer carrying the host-wide mode it left in effect. */
export function setupLayoutFixture(
  id: string,
  setup: { id: string; hostId: string; displayName?: string },
  worktreeLayoutMode: string | undefined
) {
  return okFixture(id, {
    result: {
      project: { ...ORCA_PROJECT, sourceRepoIds: [] },
      setup: {
        projectId: ORCA_PROJECT.id,
        repoId: '',
        path: '/srv/orca',
        setupState: 'ready',
        setupMethod: 'provisioned',
        createdAt: 1,
        updatedAt: 2,
        ...setup
      },
      ...(worktreeLayoutMode ? { worktreeLayoutMode } : {})
    }
  })
}
