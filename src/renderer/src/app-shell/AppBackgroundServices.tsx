import { AgentHibernationGate } from '../components/AgentHibernationGate'
import { AiVaultTabTitleSyncGate } from '../components/AiVaultTabTitleSyncGate'
import RetainedAgentsSyncGate from '../components/dashboard/RetainedAgentsSyncGate'
import { WorkspacePortScanner } from '../components/ports/WorkspacePortScanner'
import { SavedHostScopeWidenGate } from '../components/sidebar/SavedHostScopeWidenGate'
import { MacosTccPromptNoticeHost } from '../hooks/MacosTccPromptNoticeHost'
import { useAppStore } from '../store'
import { StructuredAgentSessionAttentionBridge } from '../components/native-chat/StructuredAgentSessionAttentionBridge'
import { StructuredAgentSessionStatusBridge } from '../components/native-chat/StructuredAgentSessionStatusBridge'

/**
 * App-level gates that render nothing. Each lives here rather than inside the surface that
 * needs it so its high-churn store subscriptions stay out of the App render tree.
 */
export function AppBackgroundServices(): React.JSX.Element {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)

  return (
    <>
      <WorkspacePortScanner enabled={workspaceSessionReady} />
      {/* Keep permission notices available across app surfaces. */}
      <MacosTccPromptNoticeHost />
      {/* Keep agent-status retention subscriptions out of the App render tree. */}
      <RetainedAgentsSyncGate />
      <AiVaultTabTitleSyncGate />
      <SavedHostScopeWidenGate />
      <AgentHibernationGate />
      <StructuredAgentSessionStatusBridge />
      {/* Background chats have no mounted pane but still need completion attention. */}
      <StructuredAgentSessionAttentionBridge />
    </>
  )
}
