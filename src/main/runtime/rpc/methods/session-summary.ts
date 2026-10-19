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
    handler: async (params) => {
      // Why reject rather than fall back: the requesting client resolved this from its own
      // Settings → Agents. Substituting this host's choice would spawn an agent the reader
      // never picked for a session's own text — so an unusable selection fails the fold.
      const foldParams = parseSessionSummaryFoldParams(params.foldParams ?? null)
      if (!foldParams) {
        throw new Error('The requesting window did not name a usable summarization agent.')
      }
      return sessionSummaryHostService().open({ paneKey: params.paneKey, foldParams })
    }
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
