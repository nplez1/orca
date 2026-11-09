import { resolveTuiAgentLaunchEnv } from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { RuntimeWorkspaceCatalog } from './catalog/workspace-catalog'
import type { OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController } from '../terminal/lifecycle/pty-worktree-refresh'
import type { RuntimeAccountController } from '../agent-session/environment/runtime-account-controller'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from '../session-tabs/structured-session-create-support'
import type { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../orchestration/mailbox/routing/terminal-pane-mail-routing'
import { OrcaRuntimeWithSetupRunnerState } from '../orca-runtime-setup-runner-state'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { Repo } from '../../../shared/repo-types'
import { escalateChatWorkerError } from '../orchestration/workers/turn-stops/chat-worker-error-escalation'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'

/** Members the worktree listing reads from later runtime layers; declarations only. */
export abstract class OrcaRuntimeWithWorktreePsDependencies extends OrcaRuntimeWithSetupRunnerState {
  /** Apply the host-owning desktop's account overlay to configured agent environment. */
  protected structuredAgentLaunchEnv(
    agent: StructuredAgentId,
    settings: Pick<GlobalSettings, 'agentDefaultEnv'>
  ) {
    return {
      ...resolveTuiAgentLaunchEnv(agent, settings),
      ...this.accounts.hostLaunchEnvFor(agent)
    }
  }

  protected abstract listResolvedWorktreeSnapshot(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  protected abstract refreshPtyWorktreeRecordsFromController(
    ...args: Parameters<
      OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
    >
  ): ReturnType<
    OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
  >
  abstract notifyFolderWorkspaceChanged(): void
  abstract notifyBranchRenamed(repoId: string): void
  abstract notifyWorktreeFolderRenamed(
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ): void
  declare getCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['getCommitMessageAgentEnvironment']
  abstract refreshStructuredConversationTabTitle(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
    >
  ): ReturnType<
    OrcaRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
  >
  abstract resolveStructuredAgentAccountHome(
    ...args: Parameters<
      OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
    >
  ): ReturnType<
    OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
  >
  abstract resolveStructuredAgentLaunchAccountHome(
    ...args: Parameters<
      OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
    >
  ): ReturnType<
    OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
  >
  abstract onStructuredSessionStatusForMail(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  protected abstract assertStructuredChatAcquireAdmissible(
    record: AgentSessionRecord
  ): Promise<void>
  abstract onStructuredSessionTabHidden(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  /** A chat worker whose request settled failed tells the Run that dispatched it. */
  onStructuredRequestFailureForErrorMail(failure: StructuredAgentSessionRequestFailure): void {
    void escalateChatWorkerError(failure, this.workerTurnStopReportDeps)
  }
}
