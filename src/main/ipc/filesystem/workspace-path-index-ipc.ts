import { app, ipcMain } from 'electron'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../../shared/workspace-path-search-instrumentation'
import { summarizeWorkspacePathSearchDiagnostics } from '../workspace-path-search-diagnostics-summary'
import { exportQuickOpenPathSearchInstrumentation } from '../quick-open-path-inventory'
import { resolveAuthorizedPath } from '../filesystem-auth'
import {
  createLocalWorkspacePathIndexService,
  WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION
} from '../../workspace-path-index/workspace-path-index-runtime'
import { workspacePathCatalogFoldCacheKey } from '../../../shared/workspace-path-catalog'
import { isWorkspacePathIndexEnabled } from '../../workspace-path-index/workspace-path-index-feature-switch'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../../shared/__fixtures__/workspace-path-memory-measurement'
import type { WorkspacePathSearchOwnerIdentity } from '../../../shared/workspace-path-search-contract'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** Registers shared path-index leases and development-only diagnostics. */
export function registerWorkspacePathIndexIpc(context: FilesystemHandlerContext) {
  const { store } = context
  const eventsByCorrelationId = new Map<string, WorkspacePathSearchInstrumentationEvent[]>()
  const recordEvent = (event: WorkspacePathSearchInstrumentationEvent): void => {
    const correlationId = eventCorrelationId(event)
    const events = eventsByCorrelationId.get(correlationId) ?? []
    events.push(event)
    if (events.length > 128) {
      events.shift()
    }
    eventsByCorrelationId.set(correlationId, events)
    if (eventsByCorrelationId.size > 128) {
      const oldestId = eventsByCorrelationId.keys().next().value
      if (oldestId) {
        eventsByCorrelationId.delete(oldestId)
      }
    }
  }
  const service = createLocalWorkspacePathIndexService(store, recordEvent)
  const leasesBySender = new Map<number, Map<string, string>>()
  const cleanupRegistered = new Set<number>()

  const releaseSenderLeases = (senderId: number): void => {
    const leases = leasesBySender.get(senderId)
    if (!leases) {
      return
    }
    for (const leaseId of leases.keys()) {
      service.releaseLease(leaseId)
    }
    leasesBySender.delete(senderId)
    cleanupRegistered.delete(senderId)
  }

  const trackSender = (sender: Electron.WebContents): void => {
    if (cleanupRegistered.has(sender.id)) {
      return
    }
    cleanupRegistered.add(sender.id)
    sender.once?.('destroyed', () => releaseSenderLeases(sender.id))
    sender.once?.('render-process-gone', () => releaseSenderLeases(sender.id))
    if (sender.isDestroyed?.()) {
      releaseSenderLeases(sender.id)
    }
  }

  ipcMain.handle(
    'fs:acquireQuickOpenPathInventoryLease',
    async (
      event,
      args: {
        rootPath: string
        includeIgnoredFiles: boolean
        correlationId?: WorkspacePathSearchCorrelationId
      }
    ): Promise<{ leaseId: string | null }> => {
      if (!isWorkspacePathIndexEnabled()) {
        return { leaseId: null }
      }
      const root = await resolveAuthorizedPath(args.rootPath, store)
      if (event.sender.isDestroyed()) {
        return { leaseId: null }
      }
      const leaseId = await service.acquireLease({
        owner: localOwner(root),
        listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
        foldVersion: workspacePathCatalogFoldCacheKey(),
        buildReservationBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
        firstScope: args.includeIgnoredFiles ? 'all' : 'included',
        correlationId: args.correlationId ?? `lease-${event.sender.id}`
      })
      if (!leaseId) {
        return { leaseId: null }
      }
      let senderLeases = leasesBySender.get(event.sender.id)
      if (!senderLeases) {
        senderLeases = new Map()
        leasesBySender.set(event.sender.id, senderLeases)
      }
      senderLeases.set(leaseId, args.rootPath)
      trackSender(event.sender)
      return { leaseId }
    }
  )

  ipcMain.handle(
    'fs:releaseQuickOpenPathInventoryLease',
    (event, args: { leaseId: string }): void => {
      const senderLeases = leasesBySender.get(event.sender.id)
      if (!senderLeases?.has(args.leaseId)) {
        return
      }
      senderLeases.delete(args.leaseId)
      service.releaseLease(args.leaseId)
      if (senderLeases.size === 0) {
        leasesBySender.delete(event.sender.id)
      }
    }
  )

  ipcMain.handle('fs:exportWorkspacePathSearchInstrumentation', () => {
    requireDevelopmentDiagnostics()
    const records = [...eventsByCorrelationId].map(([correlationId, events]) => ({
      correlationId,
      workspaceIdentityHash: 'worker-owned-index',
      events: [...events]
    }))
    return [...exportQuickOpenPathSearchInstrumentation(), ...records]
  })
  ipcMain.handle('fs:getWorkspacePathSearchDiagnosticsSummary', () => {
    requireDevelopmentDiagnostics()
    const events = [
      ...[...eventsByCorrelationId.values()].flat(),
      ...exportQuickOpenPathSearchInstrumentation().flatMap((record) => record.events)
    ]
    return summarizeWorkspacePathSearchDiagnostics(events)
  })
  return service
}

function requireDevelopmentDiagnostics(): void {
  if (app.isPackaged) {
    throw new Error('Workspace path search diagnostics are available only in development.')
  }
}

function localOwner(rootPath: string): WorkspacePathSearchOwnerIdentity {
  return {
    executionHost: { provider: 'local', incarnationId: String(process.pid) },
    authorizedCanonicalRoot: rootPath
  }
}

function eventCorrelationId(event: WorkspacePathSearchInstrumentationEvent): string {
  switch (event.kind) {
    case 'stage-timing':
      return event.record.correlationId
    case 'query-metrics':
      return event.record.correlationId
    case 'maintenance':
      return event.record.correlationId
    case 'cache-miss':
    case 'degradation':
    case 'admission-refusal':
      return event.correlationId
  }
}
