import { lazy, Suspense } from 'react'
import { AgentHibernationGate } from '../components/AgentHibernationGate'
import { AiVaultTabTitleSyncGate } from '../components/AiVaultTabTitleSyncGate'
import RetainedAgentsSyncGate from '../components/dashboard/RetainedAgentsSyncGate'
import { WorkspacePortScanner } from '../components/ports/WorkspacePortScanner'
import { SavedHostScopeWidenGate } from '../components/sidebar/worktree-list/listing/SavedHostScopeWidenGate'
import { MacosTccPromptNoticeHost } from '../hooks/MacosTccPromptNoticeHost'
import { RemoteHostBrowserControlNoticeHost } from '../components/browser-pane/remote-host-control/RemoteHostBrowserControlNoticeHost'
import { useAppStore } from '../store/index'
import { ActiveWorkspaceSyncGate } from './ActiveWorkspaceSyncGate'
import { StructuredAgentSessionAttentionBridge } from '../components/native-chat/session/attention/StructuredAgentSessionAttentionBridge'
import { StructuredAgentSessionStatusBridge } from '../components/native-chat/session/status/StructuredAgentSessionStatusBridge'
import { NativeChatVisualGuestThemePublisher } from '../components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher'
import { usePairedMobileDevices } from '../components/mobile/paired-mobile-devices'

/**
 * App-level gates that render nothing. Each lives here rather than inside the surface that
 * needs it so its high-churn store subscriptions stay out of the App render tree.
 */
const AgentListVerdictPublisher = lazy(
  () => import('../components/activity/agent-list-verdict-publisher')
)

export function AppBackgroundServices(): React.JSX.Element {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const canPublishAgentList = Boolean(window.api.agentStatus?.publishListVerdicts)
  // The list builds on every agent update, so only a desktop with a paired phone pays for it.
  const { hasPairedDevice } = usePairedMobileDevices({ enabled: canPublishAgentList })

  return (
    <>
      <NativeChatVisualGuestThemePublisher />
      <WorkspacePortScanner enabled={workspaceSessionReady} />
      <ActiveWorkspaceSyncGate />
      {/* Keep permission notices available across app surfaces. */}
      <MacosTccPromptNoticeHost />
      <RemoteHostBrowserControlNoticeHost />
      {/* Keep agent-status retention subscriptions out of the App render tree. */}
      <RetainedAgentsSyncGate />
      <AiVaultTabTitleSyncGate />
      <SavedHostScopeWidenGate />
      <AgentHibernationGate />
      {/* Paired phones list agents with the desktop Agents list's verdicts; web clients have no host to tell. */}
      {canPublishAgentList && hasPairedDevice ? (
        <Suspense fallback={null}>
          <AgentListVerdictPublisher />
        </Suspense>
      ) : null}
      <StructuredAgentSessionStatusBridge />
      {/* Background chats have no mounted pane but still need completion attention. */}
      <StructuredAgentSessionAttentionBridge />
    </>
  )
}
