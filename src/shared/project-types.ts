import type { ExecutionHostId } from './execution-host'
import type { RepoIcon } from './repo-icon'
import type { GitRemoteIdentity } from './git-remote-identity'
import type { LocalWindowsRuntimePreference } from './project-execution-runtime'
import type { RepoHookSettings } from './orca-yaml-hook-types'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'
import type { WorktreeLayoutMode } from './orca-workspace-layout'
import type { Repo, RepoKind } from './repo-types'
import type { ProjectHostSetupTarget } from './project-host-setup-target'

export type ProjectProviderIdentity = {
  provider: 'github'
  owner: string
  repo: string
  host?: string
}

export type Project = {
  id: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  kind?: RepoKind
  providerIdentity?: ProjectProviderIdentity
  gitRemoteIdentity?: GitRemoteIdentity
  /** Local Windows projects inherit the global runtime default unless this override is set. */
  localWindowsRuntimePreference?: LocalWindowsRuntimePreference
  sourceRepoIds: string[]
  createdAt: number
  updatedAt: number
}

export type ProjectUpdateArgs = {
  projectId: string
  updates: Partial<Pick<Project, 'localWindowsRuntimePreference'>>
}

export type ProjectHostSetupState = 'ready' | 'not-set-up' | 'setting-up' | 'error' | 'unsupported'
export type ProjectHostSetupMethod =
  | 'legacy-repo'
  | 'imported-existing-folder'
  | 'cloned'
  | 'provisioned'
export type RepoProjectHostSetupMethod = Extract<
  ProjectHostSetupMethod,
  'imported-existing-folder' | 'cloned'
>

export type ProjectHostSetup = {
  id: string
  projectId: string
  hostId: ExecutionHostId
  repoId: string
  path: string
  displayName: string
  kind?: RepoKind
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  /** Renderer projection of the paired runtime that owns this setup's transport. */
  runtimeOwnerEnvironmentId?: string
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  gitUsername?: string
  setupState: ProjectHostSetupState
  setupMethod: ProjectHostSetupMethod
  sourceControlAi?: RepoSourceControlAiOverrides
  createdAt: number
  updatedAt: number
}

export type ProjectHostSetupExistingFolderArgs = {
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  hostId: ExecutionHostId
  path: string
  kind?: RepoKind
  displayName?: string
  setupMethod?: RepoProjectHostSetupMethod
}

export type ProjectHostSetupCreateArgs = {
  projectId: string
  hostId: ExecutionHostId
  setupId?: string
  path?: string
  kind?: RepoKind
  displayName?: string
  worktreeBasePath?: string
  /** Host-level placement mode for new workspaces. It rides this call because the CLI has no
   *  settings command, so project setup is the only placement surface it exposes. */
  worktreeLayoutMode?: WorktreeLayoutMode
  gitUsername?: string
  setupState?: ProjectHostSetupState
  setupMethod?: Exclude<ProjectHostSetupMethod, 'legacy-repo'>
}

export type ProjectHostSetupCloneArgs = {
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  hostId: ExecutionHostId
  url: string
  destination: string
  displayName?: string
}

export type ProjectHostSetupUpdateArgs = ProjectHostSetupTarget & {
  updates: Partial<
    Pick<
      ProjectHostSetup,
      | 'displayName'
      | 'path'
      | 'worktreeBasePath'
      | 'setupState'
      | 'setupMethod'
      | 'gitUsername'
      | 'kind'
    >
  > & {
    /** Host-level placement mode, applied to the host rather than to this setup record. */
    worktreeLayoutMode?: WorktreeLayoutMode
  }
}

export type ProjectHostSetupDeleteArgs = ProjectHostSetupTarget & {
  /** `false` refuses while the project has live terminals or workspace metadata; absent skips the check. */
  force?: boolean
}

export type ProjectHostSetupResult = {
  project: Project
  setup: ProjectHostSetup
  repo: Repo
}

export type ProjectHostSetupCreateResult = {
  project: Project
  setup: ProjectHostSetup
  /** The host-wide placement mode the call left in effect, present only when the call carried
   *  one. A host that answers without it — a build from before the field — cannot confirm the
   *  mode, which is different from reporting one that differs. */
  worktreeLayoutMode?: WorktreeLayoutMode
}

export type ProjectHostSetupUpdateResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
  /** See `ProjectHostSetupCreateResult`. */
  worktreeLayoutMode?: WorktreeLayoutMode
}

export type ProjectHostSetupDeleteResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
}
