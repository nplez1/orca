// `sessionSummary` in the paired browser client: the pane asks the host that owns the session
// to fold it, then follows that host's snapshots by polling.
//
// A web client holds no summary state of its own — no ledger, no seen cursor, no chunk cache.
// The paired desktop is the folding side, so this is a transport plus the same lease and
// polling bookkeeping the desktop uses for a fold it does not own.
import type { SessionSummaryApi } from '../../../../preload/api/session-summary-api'
import { createSessionSummaryHostFoldClient } from '../../../../shared/session-summary-host-fold-client'
import { SessionSummaryHostFoldSubscription } from '../../../../shared/session-summary-host-subscription'
import { SessionSummaryPaneLeases } from '../../../../shared/session-summary-pane-leases'
import { resolveSessionSummaryAiParams } from '../../../../shared/session-summary-ai'
import {
  failedSessionSummarySnapshot,
  SESSION_SUMMARY_IDLE_FOLD,
  type SessionSummaryCloseRequest,
  type SessionSummaryOpenRequest,
  type SessionSummarySnapshot
} from '../../../../shared/session-summary-types'
import { unwrapRuntimeRpcResult } from '../../runtime/rpc/calls/runtime-rpc-result'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import { getStoredSettings } from './web-preferences-store'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'

export const WEB_SESSION_SUMMARY_NO_HOST_MESSAGE = 'Pair this web client with an Orca server first.'

export function createWebSessionSummaryApi(): SessionSummaryApi {
  const listeners = new Set<(snapshot: SessionSummarySnapshot) => void>()
  const leases = new SessionSummaryPaneLeases()
  /** What each pane is showing, so a refresh answers with it instead of blanking to a skeleton. */
  const shown = new Map<string, SessionSummarySnapshot>()
  /** The pairing each pane was opened against: a close belongs to the host that took the lease. */
  const openedOn = new Map<string, string>()

  const publish = (snapshot: SessionSummarySnapshot): void => {
    // Nothing here is reading the pane: a poll that landed after the last close must not
    // resurrect it, and a snapshot kept past its close would brief the next session in it.
    if (leases.count(snapshot.paneKey) === 0) {
      return
    }
    // A progress tick carries counts and no ledger, so it must not become what a reopen shows.
    if (!snapshot.progressOnly) {
      shown.set(snapshot.paneKey, snapshot)
    }
    for (const listener of listeners) {
      listener(snapshot)
    }
  }

  const hostFold = createSessionSummaryHostFoldClient({
    // Why the envelope call and an explicit selector: it pins every follow-up request to the
    // pairing that answered the open, so a re-pair mid-fold cannot move the fold to a host
    // that never took a lease for this pane.
    call: async (environmentId, method, params) =>
      unwrapRuntimeRpcResult(await callEnvironmentEnvelope(environmentId, method, params))
  })

  const hostFolds = new SessionSummaryHostFoldSubscription({
    hostFold,
    onSnapshot: (_paneKey, snapshot) => publish(snapshot),
    // Why keep the last brief: a failed poll must not blank a summary the reader is reading.
    onError: (paneKey, error, snapshot) =>
      publish(failedSessionSummarySnapshot(paneKey, error.message, snapshot ?? shown.get(paneKey)))
  })

  return {
    open: async (request: SessionSummaryOpenRequest): Promise<SessionSummarySnapshot> => {
      const environment = requireActiveEnvironmentOrNull()
      if (!environment) {
        // Not 'unavailable': its copy names a missing transcript, and there is no host to ask.
        return failedSessionSummarySnapshot(request.paneKey, WEB_SESSION_SUMMARY_NO_HOST_MESSAGE)
      }
      openedOn.set(request.paneKey, environment.id)
      if (!request.sameViewer) {
        leases.touch(request.paneKey)
      }
      // Why the fold configuration is read here and not on the host: the fold spawns an agent,
      // and a host substituting its own choice would run one the reader never picked. This
      // client's settings are what its Settings → Agents pane edits.
      hostFolds.open({
        paneKey: request.paneKey,
        environmentId: environment.id,
        foldParams: resolveSessionSummaryAiParams(getStoredSettings()),
        ...(request.session ? { session: request.session } : {}),
        // Why forwarded: this client can read a workspace owned by a third host, and the host it
        // is paired with holds no status row for that pane.
        ...(request.executionHostId ? { executionHostId: request.executionHostId } : {}),
        ...(request.revalidateWithinMs ? { revalidateWithinMs: request.revalidateWithinMs } : {}),
        ...(request.sameViewer ? { sameViewer: true } : {})
      })
      // Why answer before the host does: the fold outlives a relay idle window, and a caller
      // waiting on it would show "up to date" over a skeleton until it landed. The host's own
      // answers arrive through `onUpdate`, which the pane subscribes to before it opens.
      return shown.get(request.paneKey) ?? foldingSnapshot(request.paneKey)
    },
    close: (request: SessionSummaryCloseRequest): void => {
      const environmentId = openedOn.get(request.paneKey)
      const remaining = leases.release(request.paneKey)
      if (remaining === 0) {
        openedOn.delete(request.paneKey)
        shown.delete(request.paneKey)
      }
      if (!environmentId) {
        return
      }
      hostFolds.close({
        paneKey: request.paneKey,
        environmentId,
        seenTimelineCount: request.seenTimelineCount,
        lastViewer: remaining === 0
      })
    },
    onUpdate: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}

function foldingSnapshot(paneKey: string): SessionSummarySnapshot {
  return {
    paneKey,
    status: 'folding',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { ...SESSION_SUMMARY_IDLE_FOLD, running: true }
  }
}
