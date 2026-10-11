// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalDrivers } from './orca-runtime-terminal-drivers'
import { confirmRunTerminalShellAlone, readRunTerminalClientUse } from './run-terminal-client-use'
import type { ExecutionHostScope } from '../../shared/execution-host'
import { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import type { IPtyProvider } from '../providers/types'
import type {
  AgentSessionCreateOperation,
  OrchestrationCompatibilitySshAttachmentAuthority,
  RestoredOrchestrationAuthorityReceipt,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { ClaudeTerminalEvidence } from '../../shared/claude-terminal-interrupt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { ObservedAgentStatusPaneIdentity } from '../ipc/agent-status-ipc-boundary'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { AgentSessionClaimSigner } from './agent-session-claim-identity'
import type { AgentStatus } from '../../shared/agent-detection'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import { reconcileRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-reconciliation'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { installOrcaRuntimeOwnedControllers } from './orca-runtime-owned-controllers'
import type { RuntimeAccountController } from './runtime-account-controller'
import type { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import type { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import type { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import type { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import type { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import type { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import type { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'
import type { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'
import type { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import type { RuntimeRepositoryRelocationController } from './runtime-repository-relocation-controller'
import type { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import type { RuntimeRepositorySparsePresets } from './runtime-repository-sparse-presets'
import type { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'
import type { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'

export class OrcaRuntimeWithPreservedBranchCleanup extends OrcaRuntimeWithTerminalDrivers {
  protected readonly preservedBranchCleanup = new RuntimePreservedBranchCleanup(() =>
    this.store ? this.requireStore() : null
  )

  protected readonly getLocalProviderFn: (() => IPtyProvider) | null

  protected readonly getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null

  protected readonly onPtyStopped: ((ptyId: string) => void) | null

  protected readonly onTerminalAgentStatus:
    | ((event: RuntimeTerminalAgentStatusEvent) => void)
    | null

  protected readonly onTerminalSideEffects: ((batch: TerminalSideEffectBatch) => void) | null

  protected readonly onClaudeTerminalEvidence:
    | ((paneKey: string, evidence: ClaudeTerminalEvidence) => void)
    | null

  protected terminalSideEffectLocalConsumerAvailable = false

  protected terminalSideEffectConsumerAvailable = false

  protected readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null

  protected readonly structuredAgentStatusSinkFn: StructuredAgentSessionStatusSink | null

  protected readonly readObservedAgentStatusPaneIdentityFn: (
    paneKey: string
  ) => ObservedAgentStatusPaneIdentity

  protected readonly getAgentProviderSessionSnapshotFn: (() => AgentStatusIpcPayload[]) | null

  protected readonly getAgentProviderSessionRowsForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null

  /** See run-terminal-client-use.ts. */
  readTerminalClientUse(ptyId: string): 'used' | 'unused' | 'unknown' {
    return readRunTerminalClientUse(this, ptyId)
  }

  confirmTerminalShellAlone(ptyId: string): Promise<boolean> {
    return confirmRunTerminalShellAlone(this.ptyController, ptyId)
  }

  /** The PTY a terminal handle drives now; a restarted pane answers with its new PTY. */
  getTerminalPtyIdForHandle(handle: string): string | null {
    return this.getLivePtyForHandle(handle)?.pty.ptyId ?? null
  }

  /** Every provider-session row this host holds, resume-identity-only rows included. */
  getAgentProviderSessionRows(): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionSnapshotFn?.() ?? []
  }

  /** Agent status rows this host holds for a pane, from hooks, OSC and titles alike. */
  getAgentStatusRowsForPane(paneKey: string): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
  }

  protected readonly attestAgentHookCompatibilityAuthorityFn:
    | ((candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null)
    | null

  protected readonly retireAgentHookCompatibilityAuthorityFn: ((paneKey: string) => void) | null

  protected readonly checkHookAgentPresenceFn:
    | ((paneKey: string) => Promise<'live' | 'unverifiable' | 'exited' | null>)
    | null

  protected readonly reconcileAgentStatusForEndedProcessFn:
    | ((paneKeys: Iterable<string>) => void)
    | null

  protected readonly dropAgentStatusForRemovedWorktreeFn:
    | ((worktreeId: string, host?: ExecutionHostScope) => void)
    | null

  protected readonly canRecoverPersistentLocalPtysFn: () => boolean

  protected readonly getPairedDeviceNameFn: (pairedDeviceId: string) => string | null

  protected readonly buildAgentHookPtyEnv: (() => Record<string, string>) | null

  protected readonly getDesktopWindowStatusFn: () => RuntimeDesktopWindowStatus

  protected readonly prepareAiVaultSessionResumeFn:
    | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
    | null

  protected readonly prepareCodexStructuredLaunchFn:
    | ((input: { launchEnv: NodeJS.ProcessEnv }) => string | null | Promise<string | null>)
    | null

  protected readonly resolveCodexStructuredLaunchHomeFn:
    | ((input: { launchEnv: NodeJS.ProcessEnv }) => string | null | Promise<string | null>)
    | null

  protected readonly prepareCodexCatalogProbeHomeFn: ((homePath: string) => void) | null

  protected readonly agentSessionClaimSigner: AgentSessionClaimSigner

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
    OrchestrationCompatibilitySshAttachmentAuthority
  >()

  protected sshRelayRecoveryGenerationByTargetId = new Map<string, number>()

  protected readonly legacyWorkerRecoveryPersistence =
    new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => this.store,
      () => this.getOrchestrationDb(),
      (worktreeId) => this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    )

  protected readonly legacyWorkerRecovery = new RuntimeLegacyWorkerTerminalRecoveryController({
    preparePlan: (dispatchIds) => this.legacyWorkerRecoveryPersistence.prepare(dispatchIds),
    resolveWorkspace: async (candidate) => {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(`id:${candidate.worktreeId}`)
      const resolved = scope.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(scope.folderWorkspace)
        : await this.resolveWorktreeSelector(`id:${scope.id}`)
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
      this.legacyWorkerRecoveryPersistence.reconcileMissing(candidate),
    notifyResolution: (candidate, resolution) =>
      this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, resolution),
    canRecoverPersistentLocalPtys: () => this.canRecoverPersistentLocalPtysFn(),
    isTerminalProvenAbsent: (candidate) => this.isLeafPtyProvenAbsent(candidate.ptyId),
    hasRequestedReleases: () =>
      this.getOrchestrationDb().listWorkerTerminalReleaseBacklog(1).length > 0,
    reconcileRequestedReleases: () =>
      reconcileRequestedWorkerTerminalReleases(this as RuntimeCommandSurfaceHost<this>),
    reconcile: (options) => this.reconcileLegacyWorkerTerminals(options),
    updateRetry: (plan, deferredDispatchIds, options) =>
      this.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
  })

  protected restoredOrchestrationAuthorityByPtyId = new Map<
    string,
    RestoredOrchestrationAuthorityReceipt
  >()

  protected ptyControllerInventorySequence = 0

  protected ptyControllerAggregateInventoryGeneration = 0

  protected ptyControllerInventoryGenerationByProvider = new Map<string, number>()

  declare protected readonly accounts: RuntimeAccountController

  declare protected readonly mobileSpeech: RuntimeMobileSpeechCatalog

  declare protected readonly mobileDictation: RuntimeMobileDictationController

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

  declare protected readonly repositoryForkBackfill: RuntimeRepositoryForkBackfill

  declare protected readonly workspaceSessions: RuntimeWorkspaceSessionController

  declare protected readonly aiVault: RuntimeAiVaultCommands

  declare protected readonly claudeAgentTeams: ClaudeAgentTeamsService

  protected readonly runtimeOwnedControllers = installOrcaRuntimeOwnedControllers(this)

  getNativeChatLaunchDraftResolutionClientEventSnapshot =
    this.nativeChatDraftResolutions.snapshot.bind(this.nativeChatDraftResolutions)

  protected emitClientEvent = this.clientEvents.emit.bind(this.clientEvents)
}
