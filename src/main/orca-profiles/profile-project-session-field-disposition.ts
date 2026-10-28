import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type SessionFieldRepoRemovalDisposition =
  /** Delete map keys belonging to the repo. */
  | 'prunedByOwnerKey'
  /** Prune by derived IDs, pane keys or scalar rules. */
  | 'prunedByBespokeRule'
  /** Untouched here; entries below distinguish other pruning paths from known residue. */
  | 'notRepoScoped'

export type SessionFieldTransferDisposition =
  /** Rekey to the destination repo and clone values. */
  | 'copiedByOwnerKey'
  /** Copy with element-level rekeying or filtering. */
  | 'copiedByBespokeRule'
  /** Source-profile-only entities cannot transfer. */
  | 'notTransferred'

type SessionFieldDisposition = {
  onRepoRemoval: SessionFieldRepoRemovalDisposition
  onTransfer: SessionFieldTransferDisposition
}

/** What host-settings replication does with a field when the main replicates to a paired host. */
export type SessionFieldHostSyncDisposition =
  /** The main's value wins and the host applies it. */
  | 'replicated'
  /** Never leaves or arrives: it describes the host it is stored on. */
  | 'hostLocal'
  /** Fills a host that holds nothing, and never overwrites a deliberate local value. */
  | 'replicatedOnlyIfEmpty'

/**
 * Every persisted session field, and what the repo-removal and project-transfer paths owe it.
 *
 * Why this exists: `clientHostedBrowserPagesByWorktree` was added to the session type and then
 * missed by three separate prune paths, because nothing made handling it mandatory. Classification
 * is now a compile error to skip, and the two owner-keyed lists below are what those paths
 * actually iterate -- so a field marked `prunedByOwnerKey` is pruned by construction.
 *
 * Not covered: `mergeWorkspaceSessions`, the apply side of a transfer, is still a hand-written
 * field list. It is safe for this field only because `extractSessionForTransfer` never emits it --
 * classify a new field as transferable and that merge has to be edited by hand.
 */
export const WORKSPACE_SESSION_FIELD_DISPOSITION = {
  // Residue: renderer reads validate this ID against live repos, so dead IDs resolve to none.
  activeRepoId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorkspaceKey: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  activeWorkspaceExecutionHostId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorktreeId: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Owner removal clears this when its tab dies; repo removal can leave it stale.
  activeTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  tabsByWorktree: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Follow tab IDs removed or carried by terminal maps.
  terminalLayoutsByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  localOnlyScrollbackByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeWorktreeIdsOnShutdown: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  openFilesByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  activeFileIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  markdownFrontmatterVisible: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  browserTabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Follow browser workspace IDs resolved above.
  browserPagesByWorkspace: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeBrowserTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Paired devices/browser profiles are source-scoped; copying rows would strand unavailable tabs.
  clientHostedBrowserPagesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'notTransferred'
  },
  // Environment cleanup debt outlives individual repos.
  clientHostedBrowserCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  pairedTerminalTabCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  activeTabTypeByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  browserUrlHistory: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  workspaceDocHistory: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeTabIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  unifiedTabs: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroups: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroupLayouts: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeGroupIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeConnectionIdsAtShutdown: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  // Residue: neither path prunes removed tabs’ remote session IDs.
  remoteSessionIdsByTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  lastVisitedAtByWorktreeId: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  defaultTerminalTabsAppliedByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Owner scans prune by worktreeId, but cross-profile source removal has no scan and leaves residue.
  sleepingAgentSessionsByPaneKey: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  terminalPtyIncarnationsByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Owner-key helpers also accept bare repo IDs.
  terminalTopologyRevisionByRepoId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  terminalSurfaceTombstonesByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Pruned by worktreeId during owner removal; transferred source residue clears on next profile load.
  closedTerminalTabTombstonesByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  // Owner removal prunes by worktreeId; closed panes do not transfer.
  closedTerminalPanesByPaneKey: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  }
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldDisposition>

// Missing classifications would leak state belonging to removed projects.
type UnclassifiedSessionField = Exclude<
  keyof WorkspaceSessionState,
  keyof typeof WORKSPACE_SESSION_FIELD_DISPOSITION
>
const exhaustive: [UnclassifiedSessionField] extends [never] ? true : never = true
void exhaustive

export const SESSION_FIELDS = Object.keys(WORKSPACE_SESSION_FIELD_DISPOSITION).filter(
  (field): field is keyof WorkspaceSessionState => field in WORKSPACE_SESSION_FIELD_DISPOSITION
)

export const SESSION_FIELDS_PRUNED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onRepoRemoval === 'prunedByOwnerKey'
)

export const SESSION_FIELDS_COPIED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onTransfer === 'copiedByOwnerKey'
)

/**
 * The `onHostSync` axis of every persisted session field: what one host replicates to another.
 *
 * Why a sibling table rather than a third key on `WORKSPACE_SESSION_FIELD_DISPOSITION`: those two
 * axes are per-field *profile* operations and every entry's comment explains them as a pair, so a
 * third key would mean rewriting all thirty-five comments to say nothing new. The two tables are
 * held to the same key set at both levels instead — the `satisfies` below is exhaustive over
 * `WorkspaceSessionState`, and `SessionFieldHostSyncKeysMatchDispositionKeys` refuses a table that
 * disagrees with its sibling — so a field added to one and forgotten in the other is a compile
 * error, which is the contract the whole table exists to keep.
 *
 * Almost everything here is `hostLocal`, and deliberately: the issue is settings and credentials,
 * not the workspace view. Which terminals, tabs and worktrees a host has open is local UI state,
 * and replicating it would fight the user on the machine they are sitting at. The two `...History`
 * maps are the exception, because they fill in a host that has nothing of its own.
 */
export const WORKSPACE_SESSION_HOST_SYNC_DISPOSITION = {
  activeRepoId: 'hostLocal',
  activeWorkspaceKey: 'hostLocal',
  activeWorkspaceExecutionHostId: 'hostLocal',
  activeWorktreeId: 'hostLocal',
  activeTabId: 'hostLocal',
  tabsByWorktree: 'hostLocal',
  terminalLayoutsByTabId: 'hostLocal',
  localOnlyScrollbackByTabId: 'hostLocal',
  activeWorktreeIdsOnShutdown: 'hostLocal',
  openFilesByWorktree: 'hostLocal',
  activeFileIdByWorktree: 'hostLocal',
  markdownFrontmatterVisible: 'hostLocal',
  browserTabsByWorktree: 'hostLocal',
  browserPagesByWorkspace: 'hostLocal',
  activeBrowserTabIdByWorktree: 'hostLocal',
  clientHostedBrowserPagesByWorktree: 'hostLocal',
  clientHostedBrowserCloseIntentsByEnvironment: 'hostLocal',
  // Why host-local for the same reason: this client's record of the closes it still owes.
  pairedTerminalTabCloseIntentsByEnvironment: 'hostLocal',
  activeTabTypeByWorktree: 'hostLocal',
  browserUrlHistory: 'replicatedOnlyIfEmpty',
  // Why host-local despite its name: the value stores a worktree id and an absolute file path, so it
  // resolves on this machine only — the table's first rule, applied to something that reads like
  // history.
  workspaceDocHistory: 'hostLocal',
  activeTabIdByWorktree: 'hostLocal',
  unifiedTabs: 'hostLocal',
  tabGroups: 'hostLocal',
  tabGroupLayouts: 'hostLocal',
  activeGroupIdByWorktree: 'hostLocal',
  activeConnectionIdsAtShutdown: 'hostLocal',
  remoteSessionIdsByTabId: 'hostLocal',
  lastVisitedAtByWorktreeId: 'hostLocal',
  defaultTerminalTabsAppliedByWorktreeId: 'hostLocal',
  sleepingAgentSessionsByPaneKey: 'hostLocal',
  terminalPtyIncarnationsByPaneKey: 'hostLocal',
  terminalTopologyRevisionByRepoId: 'hostLocal',
  terminalSurfaceTombstonesByPaneKey: 'hostLocal',
  closedTerminalTabTombstonesByTabId: 'hostLocal',
  closedTerminalPanesByPaneKey: 'hostLocal'
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldHostSyncDisposition>

// Why: the two tables are one contract, so neither may gain a key the other has not seen.
type SessionFieldHostSyncKeysMatchDispositionKeys = [
  keyof typeof WORKSPACE_SESSION_HOST_SYNC_DISPOSITION
] extends [keyof typeof WORKSPACE_SESSION_FIELD_DISPOSITION]
  ? [keyof typeof WORKSPACE_SESSION_FIELD_DISPOSITION] extends [
      keyof typeof WORKSPACE_SESSION_HOST_SYNC_DISPOSITION
    ]
    ? true
    : never
  : never
const hostSyncKeysMatch: SessionFieldHostSyncKeysMatchDispositionKeys = true
void hostSyncKeysMatch

// Why `SESSION_FIELDS` rather than a second `Object.keys` list: the two tables are pinned to the same
// key set by the assertion above and by test, so walking either one walks both.

// Why the explicit return type: the table's own type has no `replicated` member today, so indexing
// it directly narrows away the very value these filters test for and the comparison stops compiling.
function hostSyncDispositionOf(
  field: keyof WorkspaceSessionState
): SessionFieldHostSyncDisposition {
  return WORKSPACE_SESSION_HOST_SYNC_DISPOSITION[field]
}

/** The fields a host applies from the main, either always or only when it holds nothing. */
export const SESSION_FIELDS_REPLICATED_TO_HOSTS = SESSION_FIELDS.filter(
  (field) => hostSyncDispositionOf(field) === 'replicated'
)

export const SESSION_FIELDS_REPLICATED_ONLY_IF_EMPTY = SESSION_FIELDS.filter(
  (field) => hostSyncDispositionOf(field) === 'replicatedOnlyIfEmpty'
)
