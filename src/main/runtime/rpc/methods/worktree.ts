import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import { displayNameUpdatePinsLabel } from '../../../../shared/worktree/display-name-provenance'
import { getWorkspaceStatusWarning } from '../../../../shared/workspace-status-warning'
import { createWorktreeWithStartupAgent } from '../../../agent-launch/startup-agent-worktree-create'
import { defineMethod } from '../core'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { resolvePairedCallerHostId } from './paired-caller-host-id'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import {
  WorktreeCreate,
  WorktreePrefetchCreateBase
} from '../../../../shared/rpc-contract/worktree-create-params'
import {
  WorktreeActivate,
  WorktreeForceDeleteBranch,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSet,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams
} from '../../../../shared/rpc-contract/worktree-params'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'
import { WORKTREE_PROVISIONED_ROOT_METHOD } from './worktree-provisioned-root-method'
import { WORKTREE_REMOVE_METHOD } from './worktree-remove-method'

export const WORKTREE_METHODS = [
  ...WORKTREE_CATALOG_METHODS,
  defineMethod({
    name: 'worktree.teardownMissingTerminals',
    permission: 'workspace',
    params: WorktreeTeardownMissingTerminalsParams,
    handler: async (params, { runtime }) =>
      runtime.teardownMissingManagedWorktreeTerminals(
        params.repo,
        params.worktreeIds,
        params.connectionId
      )
  }),
  defineMethod({
    name: 'worktree.lineageList',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage()
    })
  }),
  defineMethod({
    name: 'worktree.show',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree)
    })
  }),
  defineMethod({
    name: 'worktree.sleep',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.sleepManagedWorktree(params.worktree)
  }),
  defineMethod({
    name: 'worktree.activate',
    permission: 'workspace',
    params: WorktreeActivate,
    handler: async (params, { runtime, clientKind }) =>
      // Why: clientKind ('mobile'|'runtime') scopes the host-renderer slept-agent
      // wake to phones so web/desktop activation behavior is unchanged.
      runtime.activateManagedWorktree(params.worktree, {
        notifyClients: params.notifyClients !== false,
        clientKind,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind,
          defaultTarget: 'host'
        })
      })
  }),
  defineMethod({
    name: 'worktree.create',
    permission: 'workspace',
    params: WorktreeCreate,
    handler: async (params, context) =>
      // Why: a mobile create interrupted by a connection migration is retried with
      // the same clientMutationId; dedupe so the host returns the in-flight/created
      // worktree instead of spawning a duplicate. No key (desktop/CLI) runs plainly.
      context.runtime.dedupeWorktreeCreate(params.repo, params.clientMutationId, async () => {
        const { runtime } = context
        const repo = await runtime.showRepo(params.repo)
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest
        })
        // Why: provenance tokens are reserved before creation so retries can recover,
        // but failed create attempts must release the reservation for a safe retry.
        try {
          const result = await createWorktreeWithStartupAgent(
            runtime,
            buildManagedWorktreeCreateArgs(
              params,
              {
                automationProvenance,
                cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
                  startupAgent: params.startupAgent ?? params.createdWithAgent,
                  createdAt: Date.now()
                }),
                creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
              },
              context
            )
          )
          finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          // Why stamped here: the create's change notification has bumped the generation, so this
          // names the catalog that contains the new worktree.
          const stamped = { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
          // Why: agent callers need a stable dispatch target without traversing
          // terminal-list layout duplicates after creating the worktree.
          return params.startupAgent && result.startupTerminal?.handle
            ? { ...stamped, agentTerminalHandle: result.startupTerminal.handle }
            : stamped
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          throw error
        }
      })
  }),
  WORKTREE_PROVISIONED_ROOT_METHOD,
  defineMethod({
    name: 'worktree.prefetchCreateBase',
    permission: 'workspace',
    params: WorktreePrefetchCreateBase,
    handler: async (params, { runtime }) => {
      await runtime.prefetchManagedWorktreeCreateBase({
        repoSelector: params.repo,
        baseBranch: params.baseBranch
      })
      return null
    }
  }),
  defineMethod({
    name: 'worktree.set',
    permission: 'workspace',
    params: WorktreeSet,
    handler: async (params, { runtime }) => {
      const worktree = await runtime.updateManagedWorktreeMeta(params.worktree, {
        displayName: params.displayName,
        ...(params.displayName !== undefined
          ? { displayNameIsPinned: displayNameUpdatePinsLabel(params.displayName) }
          : {}),
        linkedIssue: params.linkedIssue,
        linkedPR: params.linkedPR,
        suppressedGitHubPR: params.suppressedGitHubPR,
        linkedLinearIssue: params.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabMR: params.linkedGitLabMR,
        linkedGitLabIssue: params.linkedGitLabIssue,
        linkedBitbucketPR: params.linkedBitbucketPR,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
        linkedGiteaPR: params.linkedGiteaPR,
        linkedWorkItem: params.linkedWorkItem,
        linkedItems: params.linkedItems,
        ...(params.linkedItemsBase !== undefined
          ? { linkedItemsBase: params.linkedItemsBase }
          : {}),
        ...(params.linkedItemsSelectionChanged !== undefined
          ? { linkedItemsSelectionChanged: params.linkedItemsSelectionChanged }
          : {}),
        linkedTaskSourceContext: params.linkedTaskSourceContext,
        comment: params.comment,
        isArchived: params.isArchived,
        isUnread: params.isUnread,
        isPinned: params.isPinned,
        sortOrder: params.sortOrder,
        manualOrder: params.manualOrder,
        lastActivityAt: params.lastActivityAt,
        createdAt: params.createdAt,
        sparseDirectories: params.sparseDirectories,
        sparseBaseRef: params.sparseBaseRef,
        sparsePresetId: params.sparsePresetId,
        baseRef: params.baseRef,
        workspaceStatus: params.workspaceStatus,
        pushTarget: params.pushTarget,
        diffComments: params.diffComments,
        mobileDiffReview: params.mobileDiffReview,
        lineage:
          params.parentWorktree || params.noParent === true
            ? {
                parentWorktree: params.parentWorktree,
                noParent: params.noParent === true
              }
            : undefined
      })
      const warning = getWorkspaceStatusWarning(
        params.workspaceStatus,
        () => runtime.getUIState().workspaceStatuses
      )
      return { worktree, ...(warning ? { warnings: [warning] } : {}) }
    }
  }),
  defineMethod({
    name: 'worktree.persistSortOrder',
    permission: 'workspace',
    params: WorktreeSortOrder,
    handler: async (params, { runtime }) =>
      runtime.persistManagedWorktreeSortOrder(params.orderedIds)
  }),
  defineMethod({
    name: 'worktree.resolvePrBase',
    permission: 'workspace',
    params: WorktreeResolvePrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedPrBase({
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        baseRefName: params.baseRefName,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.resolveMrBase',
    permission: 'workspace',
    params: WorktreeResolveMrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedMrBase({
        repoSelector: params.repo,
        mrIid: params.mrIid,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        isCrossRepository: params.isCrossRepository
      })
  }),
  WORKTREE_REMOVE_METHOD,
  defineMethod({
    name: 'worktree.forceDeleteBranch',
    permission: 'workspace',
    params: WorktreeForceDeleteBranch,
    handler: async (params, { runtime }) => {
      const hostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      return hostId
        ? runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead,
            hostId
          )
        : runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead
          )
    }
  })
]
