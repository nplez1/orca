// `sessionSummary.*` host methods — the fold for a session that lives on this machine,
// driven by a client reading the pane from elsewhere.
//
// Additive: a host that predates them answers `method_not_found`, which the desktop
// reports as an out-of-date host. The client polls `snapshotOnHost` rather than holding
// one long call open, so a fold that outlives a relay idle window survives, and a
// reconnecting client simply keeps polling the same state.
import { defineMethod } from '../core'
import {
  sessionSummaryHostService,
  parseSessionSummaryFoldParams
} from '../../../session-summary/session-summary-host-service'
import {
  SessionSummaryCloseOnHostParams,
  SessionSummaryOpenOnHostParams,
  SessionSummarySnapshotOnHostParams
} from '../../../../shared/rpc-contract/session-summary-params'

export const SESSION_SUMMARY_RPC_METHODS = [
  defineMethod({
    name: 'sessionSummary.openOnHost',
    permission: 'workspace',
    params: SessionSummaryOpenOnHostParams,
    handler: async (params) =>
      sessionSummaryHostService().open({
        paneKey: params.paneKey,
        foldParams: parseSessionSummaryFoldParams(params.foldParams ?? null)
      })
  }),
  defineMethod({
    name: 'sessionSummary.snapshotOnHost',
    permission: 'workspace',
    params: SessionSummarySnapshotOnHostParams,
    handler: async (params) => sessionSummaryHostService().peek(params.paneKey)
  }),
  defineMethod({
    name: 'sessionSummary.closeOnHost',
    permission: 'workspace',
    params: SessionSummaryCloseOnHostParams,
    handler: async (params) => {
      sessionSummaryHostService().close({
        paneKey: params.paneKey,
        seenTimelineCount: params.seenTimelineCount
      })
      return null
    }
  })
]
