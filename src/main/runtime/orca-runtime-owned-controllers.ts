// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../shared/execution-host'
// Why this path: upstream moved the mixin into the construction module, and this is a
// type-only import, so the cycle with host-services' value import of this file is erased.
import type { OrcaRuntimeWithPreservedBranchCleanup } from './construction/runtime-host-services'
import { RuntimeAccountController } from './agent-session/environment/runtime-account-controller.ts'
import { RuntimeAiVaultCommands } from './integrations/ai-vault/runtime-ai-vault-commands.ts'
import { RuntimeMobileDictationController } from './speech/runtime-mobile-dictation-controller.ts'
import { RuntimeMobileSpeechCatalog } from './speech/runtime-mobile-speech-catalog.ts'
import { RuntimeNestedRepoImport } from './repositories/runtime-nested-repo-import.ts'
import { RuntimeProjectGroupController } from './repositories/runtime-project-group-controller.ts'
import { RuntimeProjectHostSetupController } from './repositories/runtime-project-host-setup-controller.ts'
import { RuntimeRepositoryCloneController } from './repositories/runtime-repository-clone-controller.ts'
import { RuntimeRepositoryForkBackfill } from './repositories/runtime-repository-fork-backfill.ts'
import { RuntimeRepositoryRefQueries } from './repositories/runtime-repository-ref-queries.ts'
import { RuntimeRepositoryRegistrationController } from './repositories/runtime-repository-registration-controller.ts'
import { RuntimeRepositoryRelocationController } from './runtime-repository-relocation-controller'
import { RuntimeRepositorySettingsController } from './repositories/runtime-repository-settings-controller.ts'
import { RuntimeRepositorySparsePresets } from './repositories/runtime-repository-sparse-presets.ts'
import { RuntimeServerEnvironmentCommands } from './files/server-browse/runtime-server-environment-commands.ts'
import { RuntimeWorkspaceSessionController } from './workspaces/session-hosts/runtime-workspace-session-controller.ts'
import { ClaudeAgentTeamsService } from './terminal/agent-teams/claude-agent-teams-service.ts'
import { teardownFolderWorkspacePtys } from './workspaces/removal/folder-workspace-pty-teardown.ts'
import { countRepoTerminalsNotKnownExited } from './workspaces/removal/project-removal-impact.ts'

export function installOrcaRuntimeOwnedControllers(
  runtime: OrcaRuntimeWithPreservedBranchCleanup
): void {
  runtime.accounts = new RuntimeAccountController(() => runtime.notifier)

  runtime.mobileSpeech = new RuntimeMobileSpeechCatalog(() => runtime.store)

  runtime.mobileDictation = new RuntimeMobileDictationController(() => runtime.store)

  runtime.projectHostSetups = new RuntimeProjectHostSetupController({
    getStore: () => runtime.store,
    listRepos: () => runtime.listRepos(),
    addRepo: (path, kind, hostId) => runtime.addRepo(path, kind, hostId),
    cloneRepo: (args) =>
      runtime.cloneRepo(args.url, args.destination, args.hostId, args.folderName),
    invalidateResolvedWorktrees: () => runtime.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => runtime.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => runtime.notifyReposChanged(),
    countLiveTerminalsForRepo: (repo) =>
      countRepoTerminalsNotKnownExited(repo, runtime.ptysById.values(), (ptyId) =>
        runtime.isPtyKnownExited(ptyId)
      )
  })

  runtime.projectGroups = new RuntimeProjectGroupController({
    getStore: () => runtime.store,
    resolveRepo: (...args) => runtime.managedWorktreeQueries.resolveRepoForConnection(...args),
    notifyReposChanged: () => runtime.notifyReposChanged(),
    // Why: a folder delete announces the same removal a worktree does, so its consumers wake.
    emitWorktreeLifecycle: (event) => runtime.emitWorktreeLifecycle(event),
    resolveFolderConnectionId: (workspace) => runtime.resolveFolderWorkspaceConnectionId(workspace),
    acquireFileWatcherRemoval: (path, connectionId) =>
      runtime.acquireFileWatcherRemoval(path, connectionId),
    teardownFolderWorkspacePtys: (worktreeId, connectionId) =>
      teardownFolderWorkspacePtys(
        {
          runtime,
          getLocalProvider: () => runtime.getLocalProvider(),
          onPtyStopped: runtime.onPtyStopped
        },
        worktreeId,
        connectionId
      ),
    cleanupRemovedFolderWorkspaceState: (worktreeId): void | Promise<void> => {
      // Retire runs after the awaited store cleanup, so the delete cannot
      // report before the Codex pretrust purge lands; failures degrade here.
      const cleanup =
        runtime.store && runtime.removeWorktreeMetadataAndHistory(runtime.store, worktreeId)
      return Promise.resolve(cleanup).then(() => {
        // Why every host after the local-only hub: this store mints folder ids, so none is shared.
        runtime.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, ALL_EXECUTION_HOSTS_SCOPE)
      })
    }
  })

  const repositoryCatalogDeps = {
    getStore: () => runtime.store,
    invalidateResolvedWorktrees: () => runtime.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId: string) => runtime.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => runtime.notifyReposChanged()
  }

  runtime.nestedRepoImport = new RuntimeNestedRepoImport(repositoryCatalogDeps)

  runtime.repositoryRegistrations = new RuntimeRepositoryRegistrationController(
    repositoryCatalogDeps
  )

  runtime.repositoryClones = new RuntimeRepositoryCloneController(repositoryCatalogDeps)

  runtime.repositorySettings = new RuntimeRepositorySettingsController({
    ...repositoryCatalogDeps,
    resolveRepo: (selector) => runtime.resolveRepoSelector(selector),
    forgetTerminalTopology: (repoId) => runtime.terminalTopologyRevisionByRepoId.delete(repoId),
    // Why the whole options object: the controller decides whether a removal also closes the
    // project's native chats, and forwarding only the deadline silently skipped that close.
    stopProjectTerminals: (repo, options) => runtime.stopTerminalsForProject(repo, options),
    notifyWorktreesChanged: (repoId, options) => runtime.notifyWorktreesChanged(repoId, options)
  })

  runtime.repositorySparsePresets = new RuntimeRepositorySparsePresets({
    getStore: () => runtime.store,
    resolveRepo: (selector) => runtime.resolveRepoSelector(selector)
  })

  runtime.repositoryRefQueries = new RuntimeRepositoryRefQueries({
    resolveRepo: (selector) => runtime.resolveRepoSelector(selector)
  })

  // Why here and not in a checked mixin: this field's initializer has to run before the owner map
  // in `orca-runtime-state-fields` installs the command surface, and a subclass's field would run
  // after it. Every sibling controller in this file is wired the same way.
  runtime.repositoryRelocation = new RuntimeRepositoryRelocationController({
    getStore: () => runtime.store,
    resolveRepo: (selector) => runtime.resolveRepoSelector(selector),
    getWorktreePs: (limit) => runtime.getWorktreePs(limit),
    notifyRepoRelocated: (repoId, oldId, newId) =>
      runtime.notifyWorktreeFolderRenamed(repoId, oldId, newId),
    invalidateResolvedWorktrees: () => runtime.invalidateResolvedWorktreeCache(),
    notifyReposChanged: () => runtime.notifyReposChanged()
  })

  runtime.serverEnvironment = new RuntimeServerEnvironmentCommands()

  runtime.repositoryForkBackfill = new RuntimeRepositoryForkBackfill(
    () => runtime.store,
    () => runtime.notifyReposChanged()
  )

  runtime.workspaceSessions = new RuntimeWorkspaceSessionController({
    getStore: () => runtime.store,
    resolveFolderConnectionId: (workspace) => runtime.resolveFolderWorkspaceConnectionId(workspace),
    hasRuntimeOwnedPtyCandidate: (session, worktreeId, tabs) =>
      runtime.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs),
    getCachedWorktrees: () => runtime.resolvedWorktrees.peek()?.worktrees ?? null
  })

  runtime.aiVault = new RuntimeAiVaultCommands(() => runtime.prepareAiVaultSessionResumeFn)

  runtime.claudeAgentTeams = new ClaudeAgentTeamsService()
}
