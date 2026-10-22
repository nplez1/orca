/** The pane identity and hook endpoint a harnessed extension expects in its spawn env. */
export const AGENT_STATUS_EXTENSION_BASE_ENV = {
  ORCA_PANE_KEY: 'pane-1',
  ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
  ORCA_TAB_ID: 'tab-1',
  ORCA_WORKTREE_ID: 'tree-1',
  ORCA_AGENT_HOOK_PORT: '4321',
  ORCA_AGENT_HOOK_TOKEN: 'token-1',
  ORCA_AGENT_HOOK_ENV: 'env-1',
  ORCA_AGENT_HOOK_VERSION: '1.2.3'
} satisfies Record<string, string>
