export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  issueCommand?: string // Shared default command for linked GitHub issues
  defaultTabs?: OrcaDefaultTabTemplate[] // Terminal tabs to create once for a new worktree
  environmentRecipes?: OrcaVmRecipe[] // Project-scoped per-workspace environment recipes
  environmentRecipeDiagnostics?: OrcaVmRecipeDiagnostic[] // Non-fatal validation issues from environmentRecipes
  worktree?: OrcaWorktreeDefaults // Project-scoped defaults applied when a worktree is created
}

export type OrcaWorktreeDefaults = {
  // Share large rebuildable directories such as node_modules across worktrees instead of copying installs.
  sharedDirectories?: string[]
}

export type OrcaDefaultTabTemplate = {
  title?: string
  color?: string
  command?: string
}

export type EphemeralVmCheckoutMode = 'orca-worktree' | 'provisioned-root'

export type OrcaVmRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: EphemeralVmCheckoutMode
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: boolean
  /** Requests a longer provider lease for a host created by `create`. Receives the
   *  persisted recipe result plus the requested `lifetime`; returns an updated one. */
  extend?: string
  /** The lifetimes this recipe's provider is willing to sell, such as `4h` or `1d`.
   *  Orca offers only these, so it can never ask for a lease the provider rejects. */
  extendDurations?: string[]
  /** Extra actions this recipe adds to its workspaces' context menu. Each one is offered only on
   *  a workspace whose host was created by this recipe, and clicking it runs `command` with the
   *  workspace's host name, workspace name, and workspace path. */
  contextMenuItems?: OrcaVmRecipeContextMenuItem[]
}

export type OrcaVmRecipeContextMenuItem = {
  id: string
  label: string
  command: string
}

export type OrcaVmRecipeDiagnostic = {
  index: number
  field?: string
  message: string
}

export type RepoHookSettings = {
  // Retain the old hook-UI mode so persisted state reads without migration.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type PersistedTrustedOrcaHookEntry = {
  contentHash: string
  approvedAt: number
}

export type PersistedTrustedOrcaHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedOrcaHookEntry
  archive?: PersistedTrustedOrcaHookEntry
  issueCommand?: PersistedTrustedOrcaHookEntry
  vmRecipe?: PersistedTrustedOrcaHookEntry
}

export type PersistedTrustedOrcaHooks = Record<string, PersistedTrustedOrcaHookRepo>
