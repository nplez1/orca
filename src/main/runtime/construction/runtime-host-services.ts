import { RuntimeAgentStatusSources } from './runtime-agent-status-sources'
import type { ClaudeAccountSelectedHandler } from '../../../shared/agent-accounts/managed-account-types'

import type * as Calls from './runtime-host-service-calls'
import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'

import type { LegacyWorkerRecoveryCandidate } from '../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

import type { LegacyWorkerTerminalRecoveryPlan } from '../orchestration/terminal-authority/release/orchestration-legacy-worker-terminal-recovery'

import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ResolvedWorktree } from '../workspaces/catalog/runtime-worktree-path-identity'
import {
  confirmRunTerminalShellAlone,
  readRunTerminalClientUse
} from '../terminal/lifecycle/run-terminal-client-use'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { RuntimePreservedBranchCleanup } from '../repositories/runtime-preserved-branch-cleanup'
import { installOrcaRuntimeOwnedControllers } from '../orca-runtime-owned-controllers'
import type { RuntimeRepositoryRelocationController } from '../runtime-repository-relocation-controller'
import type { AgentSessionCreateOperation } from '../session-construction/agent-session/agent-session-create-operation'
import type * as CompatibilityAuthority from '../orchestration/terminal-authority/orchestration-compatibility-authority'

import type { AgentStatus } from '../../../shared/agent-status/title/agent-title-core'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from '../orchestration/terminal-authority/runtime-legacy-worker-terminal-recovery-persistence'
import { RuntimeLegacyWorkerTerminalRecoveryController } from '../orchestration/terminal-authority/runtime-legacy-worker-terminal-recovery-controller'
import { reconcileRequestedWorkerTerminalReleases } from '../orchestration/terminal-authority/release/worker-terminal-release-reconciliation'
import { sweepStoppedWorkerTerminals } from '../orchestration/terminal-authority/release/stopped-worker-terminal-release'

import type { RuntimeAccountController } from '../agent-session/environment/runtime-account-controller'
import { createLazyMobileSpeechOwners } from '../speech/lazy-mobile-speech-owners'
import type { RuntimeProjectHostSetupController } from '../repositories/runtime-project-host-setup-controller'
import type { RuntimeProjectGroupController } from '../repositories/runtime-project-group-controller'
import type { RuntimeNestedRepoImport } from '../repositories/runtime-nested-repo-import'
import type { RuntimeRepositoryRegistrationController } from '../repositories/runtime-repository-registration-controller'
import type { RuntimeRepositoryCloneController } from '../repositories/runtime-repository-clone-controller'
import type { RuntimeRepositorySettingsController } from '../repositories/runtime-repository-settings-controller'
import type { RuntimeRepositorySparsePresets } from '../repositories/runtime-repository-sparse-presets'
import type { RuntimeRepositoryRefQueries } from '../repositories/runtime-repository-ref-queries'
import type { RuntimeServerEnvironmentCommands } from '../files/server-browse/runtime-server-environment-commands'
import type { RuntimeRepositoryForkBackfill } from '../repositories/runtime-repository-fork-backfill'
import type { RuntimeWorkspaceSessionController } from '../workspaces/session-hosts/runtime-workspace-session-controller'
import type { RuntimeAiVaultCommands } from '../integrations/ai-vault/runtime-ai-vault-commands'
import type { ClaudeAgentTeamsService } from '../terminal/agent-teams/claude-agent-teams-service'

export abstract class OrcaRuntimeWithPreservedBranchCleanup extends RuntimeAgentStatusSources {
  protected abstract finishGroupFolderCreation: Calls.FinishGroupFolderCreation
  declare acquireFileWatcherRemoval: Calls.AcquireFileWatcherRemoval
  protected abstract tryGetWorkspaceSessionHostIdForWorktree(
    worktreeId: string
  ): ExecutionHostId | null
  protected abstract getLegacyWorkerRecoveryActivation(
    ...args: Calls.GetLegacyWorkerRecoveryActivationArgs
  ): Calls.GetLegacyWorkerRecoveryActivationResult
  protected abstract hasExactPersistedTerminalSurfaceIdentity(
    ...args: Calls.HasExactPersistedTerminalSurfaceIdentityArgs
  ): Calls.HasExactPersistedTerminalSurfaceIdentityResult
  protected abstract hasExactTerminalSurfaceIdentity(
    ...args: Calls.HasExactTerminalSurfaceIdentityArgs
  ): Calls.HasExactTerminalSurfaceIdentityResult
  protected abstract adoptLegacyWorkerTerminal(
    ...args: Calls.AdoptLegacyWorkerTerminalArgs
  ): Calls.AdoptLegacyWorkerTerminalResult
  protected abstract revealLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate
  ): Promise<boolean | null>
  abstract onPtyExit(...args: Calls.OnPtyExitArgs): Calls.OnPtyExitResult
  protected abstract rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void
  abstract reconcileLegacyWorkerTerminals(
    ...args: Calls.ReconcileLegacyWorkerTerminalsArgs
  ): Calls.ReconcileLegacyWorkerTerminalsResult
  protected abstract updateLegacyWorkerTerminalRecoveryRetry(
    ...args: Calls.UpdateLegacyWorkerTerminalRecoveryRetryArgs
  ): Calls.UpdateLegacyWorkerTerminalRecoveryRetryResult
  protected abstract resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null

  protected abstract runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T>
  protected abstract folderWorkspaceToResolvedWorktree(
    folderWorkspace: FolderWorkspace
  ): ResolvedWorktree

  readonly preservedBranchCleanup = new RuntimePreservedBranchCleanup(() =>
    this.store ? this.requireStore() : null
  )

  protected readonly getLocalProviderFn!: HostBindings['getLocalProvider'] | null

  readonly onPtyStopped!: HostBindings['onPtyStopped'] | null

  protected readonly onTerminalAgentStatus!: HostBindings['onTerminalAgentStatus'] | null

  protected readonly onTerminalProgramStatusFacet!:
    | HostBindings['onTerminalProgramStatusFacet']
    | null

  protected readonly onTerminalSideEffects!: HostBindings['onTerminalSideEffects'] | null

  protected readonly onClaudeTerminalEvidence!: HostBindings['onClaudeTerminalEvidence'] | null

  protected readonly onPaneScreenPromptGained!: HostBindings['onPaneScreenPromptGained'] | null

  protected terminalSideEffectLocalConsumerAvailable = false

  protected terminalSideEffectConsumerAvailable = false

  readTerminalClientUse(ptyId: string): 'used' | 'unused' | 'unknown' {
    return readRunTerminalClientUse(this, ptyId)
  }

  confirmTerminalShellAlone(ptyId: string): Promise<boolean> {
    return confirmRunTerminalShellAlone(this.ptyController, ptyId)
  }

  protected readonly attestAgentHookCompatibilityAuthorityFn!:
    | HostBindings['attestAgentHookCompatibilityAuthority']
    | null

  protected readonly retireAgentHookCompatibilityAuthorityFn!:
    | HostBindings['retireAgentHookCompatibilityAuthority']
    | null

  protected readonly checkHookAgentPresenceFn!: HostBindings['checkHookAgentPresence'] | null

  protected readonly reconcileAgentStatusForEndedProcessFn!:
    | HostBindings['reconcileAgentStatusForEndedProcess']
    | null

  protected readonly forgetHookAgentExitFn!: HostBindings['forgetHookAgentExit'] | null

  protected readonly dropAgentStatusForRemovedWorktreeFn!:
    | HostBindings['dropAgentStatusForRemovedWorktree']
    | null

  protected readonly canRecoverPersistentLocalPtysFn!: HostBindings['canRecoverPersistentLocalPtys']

  declare protected readonly getPairedDeviceNameFn: HostBindings['getPairedDeviceName']

  protected readonly buildAgentHookPtyEnv!: HostBindings['buildAgentHookPtyEnv'] | null

  protected readonly getDesktopWindowStatusFn!: HostBindings['getDesktopWindowStatus']

  protected readonly prepareAiVaultSessionResumeFn!:
    | HostBindings['prepareAiVaultSessionResume']
    | null

  protected readonly prepareCodexStructuredLaunchFn!:
    | HostBindings['prepareCodexStructuredLaunch']
    | null

  protected readonly resolveCodexStructuredLaunchHomeFn!:
    | HostBindings['resolveCodexStructuredLaunchHome']
    | null

  protected readonly prepareCodexCatalogProbeHomeFn!:
    | HostBindings['prepareCodexCatalogProbeHome']
    | null

  protected readonly agentSessionClaimSigner!: HostBindings['agentSessionClaimSigner']

  protected readonly agentSessionCreateOperations = new Map<string, AgentSessionCreateOperation>()

  protected readonly agentPromptSubmissionTailByPtyId = new Map<string, Promise<void>>()

  protected readonly agentPromptLifecycleByPtyId = new Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >()

  protected readonly agentPromptPermissionSequenceByPtyId = new Map<string, number>()

  protected readonly agentPromptExplicitStatusFloorByPtyId = new Map<string, number>()

  protected readonly orchestrationCompatibilitySshAttachments = new Map<
    string,
    CompatibilityAuthority.OrchestrationCompatibilitySshAttachmentAuthority
  >()

  protected sshRelayRecoveryGenerationByTargetId = new Map<string, number>()

  protected readonly legacyWorkerRecoveryPersistence =
    new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => this.store,
      () => this.getExistingOrchestrationDb(),
      (worktreeId) => this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    )

  protected readonly legacyWorkerRecovery = new RuntimeLegacyWorkerTerminalRecoveryController({
    preparePlan: (dispatchIds) => this.legacyWorkerRecoveryPersistence.prepare(dispatchIds),
    resolveWorkspace: async (candidate) => {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(`id:${candidate.worktreeId}`)
      const resolved = scope.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(scope.folderWorkspace)
        : await this.resolveGitWorktreeSelector(`id:${scope.id}`)
      return { scope, resolved }
    },
    refreshInventory: (worktrees, connectionId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(
        worktrees,
        null,
        undefined,
        connectionId,
        false,
        { includeForegroundProcessEvidence: false, refreshForegroundAgents: false }
      ),
    runMutation: (worktreeId, operation) => this.runWorktreeTerminalMutation(worktreeId, operation),
    getActivation: (worktreeId) => this.getLegacyWorkerRecoveryActivation(worktreeId),
    hasExactPersistedSurface: (candidate) =>
      this.hasExactPersistedTerminalSurfaceIdentity(candidate),
    hasExactSurface: (candidate) => this.hasExactTerminalSurfaceIdentity(candidate),
    adopt: (candidate, workspace, inventory, activation) =>
      this.adoptLegacyWorkerTerminal(candidate, workspace, inventory, activation),
    getRendererEpoch: () => this.rendererGraphEpoch,
    reveal: (candidate) => this.revealLegacyWorkerTerminal(candidate),
    onPtyExit: (candidate) => this.onPtyExit(candidate.ptyId, 0, candidate.incarnationId),
    persist: (resolutions) => this.legacyWorkerRecoveryPersistence.persist(resolutions),
    rollback: (candidate) => this.rollbackLegacyWorkerTerminalSurface(candidate),
    reconcileMissing: (candidate) =>
      this.legacyWorkerRecoveryPersistence.reconcileMissing(candidate, this.lostWorkerReport),
    holdForRestartResume: (candidate) => this.holdLostWorkerForRestartResume(candidate),
    isResuming: (dispatchId) => this.terminalWorkerRestartResume.isHeld(dispatchId),
    notifyResolution: (candidate, resolution) =>
      this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, resolution),
    canRecoverPersistentLocalPtys: () => this.canRecoverPersistentLocalPtysFn(),
    isTerminalProvenAbsent: (candidate) => this.isLeafPtyProvenAbsent(candidate.ptyId),
    hasRequestedReleases: () =>
      (this.getExistingOrchestrationDb()?.listWorkerTerminalReleaseBacklog(1).length ?? 0) > 0,
    reconcileRequestedReleases: () =>
      reconcileRequestedWorkerTerminalReleases(this).then(() =>
        sweepStoppedWorkerTerminals(this, () => this.legacyWorkerRecovery.isStopped())
      ),
    reconcile: (options) => this.reconcileLegacyWorkerTerminals(options),
    updateRetry: (plan, deferredDispatchIds, options) =>
      this.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
  })

  protected restoredOrchestrationAuthorityByPtyId = new Map<
    string,
    CompatibilityAuthority.RestoredOrchestrationAuthorityReceipt
  >()

  protected ptyControllerInventorySequence = 0

  protected ptyControllerAggregateInventoryGeneration = 0

  protected ptyControllerInventoryGenerationByProvider = new Map<string, number>()

  // Constructed by installOrcaRuntimeOwnedControllers (transcript-split); the wiring there must match
  // upstream's construction, including the Claude-account selection handler.
  declare protected readonly accounts: RuntimeAccountController

  protected abstract onClaudeAccountSelected(
    ...change: Parameters<ClaudeAccountSelectedHandler>
  ): ReturnType<ClaudeAccountSelectedHandler>

  /** Seam for installOrcaRuntimeOwnedControllers, which builds `accounts` outside this class. */
  public handleClaudeAccountSelected(
    ...change: Parameters<ClaudeAccountSelectedHandler>
  ): ReturnType<ClaudeAccountSelectedHandler> {
    return this.onClaudeAccountSelected(...change)
  }

  protected readonly mobileSpeechOwners = createLazyMobileSpeechOwners(() => this.store)

  declare protected readonly projectHostSetups: RuntimeProjectHostSetupController

  declare protected readonly projectGroups: RuntimeProjectGroupController

  declare protected readonly nestedRepoImport: RuntimeNestedRepoImport

  declare protected readonly repositoryRegistrations: RuntimeRepositoryRegistrationController

  declare protected readonly repositoryClones: RuntimeRepositoryCloneController

  declare protected readonly repositorySettings: RuntimeRepositorySettingsController

  declare protected readonly repositorySparsePresets: RuntimeRepositorySparsePresets

  declare protected readonly repositoryRefQueries: RuntimeRepositoryRefQueries

  declare protected readonly repositoryRelocation: RuntimeRepositoryRelocationController

  declare protected readonly serverEnvironment: RuntimeServerEnvironmentCommands

  // Public: the repository command surface and its specs read the backfill directly (upstream declares it so).
  declare readonly repositoryForkBackfill: RuntimeRepositoryForkBackfill

  declare protected readonly workspaceSessions: RuntimeWorkspaceSessionController

  declare protected readonly aiVault: RuntimeAiVaultCommands

  declare protected readonly claudeAgentTeams: ClaudeAgentTeamsService

  protected readonly runtimeOwnedControllers = installOrcaRuntimeOwnedControllers(this)

  getNativeChatLaunchDraftResolutionClientEventSnapshot =
    this.nativeChatDraftResolutions.snapshot.bind(this.nativeChatDraftResolutions)

  protected emitClientEvent = this.clientEvents.emit.bind(this.clientEvents)
}
