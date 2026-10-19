// Desktop-side client for a fold that runs on the paired host owning the session.
//
// Polling, not a held-open call: a fold of a long session outlives a relay idle window,
// and the pane only ever needs "is it still running, and what is the ledger now". The
// host owns the ledger, the chunk cache, the resume point and the seen cursor for its
// own panes, so nothing about them is duplicated here.
import {
  SessionSummaryCloseOnHostParams,
  SessionSummaryOpenOnHostParams,
  SessionSummarySnapshotOnHostParams
} from '../../shared/rpc-contract/session-summary-params'
import {
  SESSION_SUMMARY_HOST_OUTDATED_MESSAGE,
  type SessionSummarySnapshot
} from '../../shared/session-summary-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { isUnknownSessionSearchMethod } from '../../shared/ai-vault-search-client'

export type SessionSummaryHostFoldClient = {
  open: (args: {
    environmentId: string
    paneKey: string
    foldParams: ResolvedSourceControlAiGenerationParams | null
  }) => Promise<SessionSummarySnapshot>
  peek: (args: { environmentId: string; paneKey: string }) => Promise<SessionSummarySnapshot>
  close: (args: {
    environmentId: string
    paneKey: string
    seenTimelineCount: number
  }) => Promise<void>
}

export function createSessionSummaryHostFoldClient(deps: {
  /** Calls one runtime method on that paired host, resolving its result. */
  call: (environmentId: string, method: string, params: Record<string, unknown>) => Promise<unknown>
}): SessionSummaryHostFoldClient {
  const call = async (
    environmentId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> => {
    try {
      return await deps.call(environmentId, method, params)
    } catch (error) {
      // Why: a paired host updates on its own schedule, so "this build has no such
      // method" is a normal state the pane must name, not a mystery failure.
      if (isUnknownSessionSearchMethod(error)) {
        throw Object.assign(new Error(SESSION_SUMMARY_HOST_OUTDATED_MESSAGE), {
          code: SESSION_SUMMARY_HOST_OUTDATED_MESSAGE
        })
      }
      throw error
    }
  }
  return {
    open: async ({ environmentId, paneKey, foldParams }) =>
      asSnapshot(
        await call(
          environmentId,
          'sessionSummary.openOnHost',
          SessionSummaryOpenOnHostParams.parse({
            paneKey,
            foldParams: portableFoldParams(foldParams)
          })
        )
      ),
    peek: async ({ environmentId, paneKey }) =>
      asSnapshot(
        await call(
          environmentId,
          'sessionSummary.snapshotOnHost',
          SessionSummarySnapshotOnHostParams.parse({ paneKey })
        )
      ),
    close: async ({ environmentId, paneKey, seenTimelineCount }) => {
      await call(
        environmentId,
        'sessionSummary.closeOnHost',
        SessionSummaryCloseOnHostParams.parse({ paneKey, seenTimelineCount })
      )
    }
  }
}

/**
 * The fold configuration as it can mean something on another machine.
 *
 * `agentCommandOverride` is a command line this desktop is configured to run — a path, an
 * install-specific flag set. Spawned on the host it would ENOENT or run something else, so
 * the host resolves the binary for `agentId` itself. `customAgentCommand` is sent as-is:
 * it names an agent, which is the user's own choice to make portable.
 */
function portableFoldParams(
  params: ResolvedSourceControlAiGenerationParams | null
): Record<string, unknown> | null {
  if (!params) {
    return null
  }
  const portable = { ...params }
  delete portable.agentCommandOverride
  return portable
}

/**
 * The host runs this same service, so its snapshot is the same shape; reject anything else.
 *
 * Why check `fold.running` specifically: the poll loop reads it on every tick, and a missing
 * or non-boolean value there would decide "settled" by accident.
 */
function asSnapshot(value: unknown): SessionSummarySnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('paneKey' in value) ||
    typeof value.paneKey !== 'string' ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !('fold' in value) ||
    typeof value.fold !== 'object' ||
    value.fold === null ||
    !('running' in value.fold) ||
    typeof value.fold.running !== 'boolean'
  ) {
    throw new Error('host returned an invalid session summary snapshot')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields above are the ones the polling loop and the pane branch on; a host running this same code returns this same type, and anything else throws here rather than reaching the pane.
  return value as SessionSummarySnapshot
}
