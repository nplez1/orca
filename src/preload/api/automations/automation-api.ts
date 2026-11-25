import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { ExternalAutomationManager } from '../../../shared/automations/external/external-automation'
import type { AutomationOwnerRef } from '../../../shared/automations/ownership/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerListRequest
} from '../../../shared/automations/external/external-automation-scope'
import type { AutomationsChangedPayload } from '../../../shared/remote-runtime/session-graph/runtime-client-events'

export type ExternalAutomationManagerResult = {
  /** Null once a probe succeeded and found no manager configured for this scope. */
  manager: ExternalAutomationManager | null
  error: string | null
  updatedAt: number
}

// Automation CRUD uses runtime RPC; this IPC API handles desktop-only calls.
export type AutomationsApi = {
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerResult>
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest) => Promise<void>
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }) => Promise<void>
  snapshotWorkspaceName: (args: {
    workspaceId: string
    hostId: ExecutionHostId
    displayName: string
  }) => Promise<number>
  /** Pins the content a run refused; the host derives the pin from that run's record. */
  approveScriptStep: (request: {
    automationId: string
    runId: string
    stepId: string
  }) => Promise<void>
  onChanged: (callback: (payload: AutomationsChangedPayload) => void) => () => void
}
