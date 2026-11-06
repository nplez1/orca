// One fold, end to end: read the transcript, fold it in bounded chunks, persist the result.
//
// Kept out of the service so the service stays the lazy-lifecycle layer (open/close and
// which host folds) while this is the chapter that can fail: a transcript read, a model
// extract, or a write. Nothing is applied on failure, and completed chunk extracts are
// kept so a retry resumes instead of restarting.
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { AgentType } from '../../shared/agent-status-types'
import type {
  SessionSummaryLedger,
  SessionSummarySessionRef,
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { foldSessionSummaryEvents, type SessionFoldBrain } from './session-summary-fold'
import { IDLE_FOLD, type SessionSummaryStatusEntry } from './session-summary-snapshot'
import { rewriteSessionSummaryReports } from './session-summary-report'
import { withSessionSummaryFoldSlot } from './session-summary-fold-slots'
import type { SessionSummaryStore } from './session-summary-store'
import { chunkCacheFor, persist, storedEntry } from './session-summary-fold-persist'
import type {
  SessionSummaryEventRead,
  SessionSummarySessionIdentity
} from './session-summary-transcript-source'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'
import { mergeSessionRef, sessionSummaryIdentityOf } from './session-summary-session-ref'

export {
  hasSessionRef,
  mergeSessionRef,
  sessionSummaryIdentityChanged,
  sessionSummaryIdentityOf
} from './session-summary-session-ref'

export type SessionSummaryFoldRunnerDeps = {
  store: SessionSummaryStore
  /** Events from `fromEventIndex` on, plus the transcript's total, so a fold never re-reads a prefix. */
  readEvents: (args: {
    identity: SessionSummarySessionIdentity
    host: SessionSummaryTranscriptHost
    signal: AbortSignal
    fromEventIndex: number
  }) => Promise<SessionSummaryEventRead | null>
  getAgentStatusEntry: (paneKey: string) => SessionSummaryStatusEntry | undefined
  /**
   * Whether this build can decode that agent's transcript at all. Injected rather than
   * imported so the runner stays the orchestrator and the transcript module stays the reader;
   * it only decides which sentence an empty fold gets.
   */
  canReadTranscript?: (agentType: AgentType) => boolean
  createBrain: (params: ResolvedSourceControlAiGenerationParams | null) => SessionFoldBrain
  now: () => number
}

export type SessionSummaryFoldCallbacks = {
  /** Everything a fold reports back: progress, the settled status, and the failure. */
  onStatus: (update: {
    status: SessionSummaryStatus
    fold: SessionSummarySnapshot['fold']
    messageCount?: number
    error?: string
    /** A per-chunk tick: merge the counts, keep the ledger already on screen. */
    progressOnly?: boolean
  }) => void
}

/** Fold a pane's new events. Resolves when the fold settles; never throws. */
export async function runSessionSummaryFold(args: {
  deps: SessionSummaryFoldRunnerDeps
  callbacks: SessionSummaryFoldCallbacks
  paneKey: string
  host: SessionSummaryTranscriptHost
  /** The viewer's own record of the session; it fills in what this process's row cannot say. */
  requestedSession?: SessionSummarySessionRef
  foldParams: ResolvedSourceControlAiGenerationParams | null
  signal: AbortSignal
}): Promise<void> {
  const { deps, callbacks, paneKey, host, signal } = args
  const report = callbacks.onStatus
  try {
    // Why the slot covers the read, and why nothing is resolved before it: `readEvents` builds the
    // fold's whole event array, so N panes restoring at once would allocate N transcripts before any
    // fold was admitted — and a wait that long is long enough for the pane's identity to change.
    await withSessionSummaryFoldSlot(signal, () =>
      runAdmittedFold({
        deps,
        report,
        paneKey,
        host,
        requestedSession: args.requestedSession,
        signal,
        foldParams: args.foldParams
      })
    )
  } catch (error) {
    if (signal.aborted) {
      return // Pane closed: cancel-on-close, nothing to report.
    }
    // Completed chunk extracts survive a failure: each one is written as it settles, so a retry
    // resumes instead of restarting even when no ledger was ever produced.
    const failedSession = mergeSessionRef(args.requestedSession, deps.getAgentStatusEntry(paneKey))
    const failedIdentity = sessionSummaryIdentityOf(failedSession)
    const failedStored = storedEntry(deps, paneKey, failedIdentity)
    persist(deps, paneKey, failedIdentity, failedStored, failedStored.messageCount)
    report({
      status: 'failed',
      fold: IDLE_FOLD,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** One admitted fold: resolve the pane's session, read the transcript, fold, persist, report. */
async function runAdmittedFold(args: {
  deps: SessionSummaryFoldRunnerDeps
  report: SessionSummaryFoldCallbacks['onStatus']
  paneKey: string
  host: SessionSummaryTranscriptHost
  requestedSession?: SessionSummarySessionRef
  signal: AbortSignal
  foldParams: ResolvedSourceControlAiGenerationParams | null
}): Promise<void> {
  const { deps, report, paneKey, host, signal } = args
  const session = mergeSessionRef(args.requestedSession, deps.getAgentStatusEntry(paneKey))
  const identity = sessionSummaryIdentityOf(session)
  const stored = storedEntry(deps, paneKey, identity)
  const read = await deps.readEvents({
    identity: session,
    host,
    signal,
    fromEventIndex: stored.ledger.foldedThrough
  })
  const eventsReadAt = deps.now()
  signal.throwIfAborted()
  if (!read) {
    report({
      status: 'unavailable',
      fold: IDLE_FOLD,
      // Why: "no readable transcript yet" is true for a session that has not written one,
      // and misleading for one whose transcript exists somewhere this fold cannot read.
      ...(session.providerSession?.id
        ? { error: unavailableTranscriptReason(session, deps.canReadTranscript) }
        : {})
    })
    return
  }
  const newEvents = read.events
  const messageCount = read.totalEvents
  if (newEvents.length === 0) {
    // Why a report pass here: a fold whose report phase failed leaves `reportFull.through` behind
    // its `foldedThrough`, and a session with nothing new would otherwise never catch it up.
    const caughtUp = await catchUpSessionSummaryReports({
      deps,
      signal,
      ledger: stored.ledger,
      foldParams: args.foldParams
    })
    // Persist first: the snapshot a listener receives reads the store, so reporting
    // 'ready' before the write showed a ready status over an absent ledger.
    persist(deps, paneKey, identity, { ...stored, ledger: caughtUp }, messageCount)
    report({
      // No readable content yet is 'unavailable', not a summary of nothing.
      status: messageCount === 0 ? 'unavailable' : 'ready',
      fold: IDLE_FOLD,
      messageCount,
      ...(messageCount === 0
        ? { error: unavailableTranscriptReason(session, deps.canReadTranscript, 'empty') }
        : {})
    })
    return
  }
  const result = await foldSessionSummaryEvents({
    brain: deps.createBrain(args.foldParams),
    ledger: stored.ledger,
    events: newEvents,
    signal,
    readAt: eventsReadAt,
    cache: chunkCacheFor(stored),
    gaps: read.gaps,
    // Why write per chunk and not only at the end: quitting mid-fold used to lose every completed
    // extract, so reopening a long first fold restarted at event 0. The store debounces the write.
    onChunkSettled: () => persist(deps, paneKey, identity, stored, messageCount),
    onProgress: (progress) =>
      report({
        status: 'folding',
        fold: {
          running: true,
          completedChunks: progress.completedChunks,
          totalChunks: progress.totalChunks
        },
        messageCount,
        progressOnly: true
      })
  })
  signal.throwIfAborted()
  persist(deps, paneKey, identity, { ...stored, ledger: result.ledger }, messageCount)
  report({
    status: 'ready',
    fold: {
      running: false,
      completedChunks: result.completedChunks,
      totalChunks: result.totalChunks
    },
    messageCount,
    // Why an error and not a failed status: the chunks that landed are real, and reporting
    // 'failed' over them is what threw away a forty-chunk fold's work for one flaky call.
    ...(result.gap
      ? {
          error: `${result.gap.completedChunks} of ${result.gap.totalChunks} sections summarized; the rest will be filled in on the next fold.`
        }
      : {})
  })
}

/**
 * Rewrite the report for facts already folded but not yet reported on.
 *
 * Returns the ledger unchanged when there is nothing to catch up, and when the rewrite fails — the
 * facts are already on screen, so a stale sentence is a smaller loss than an error.
 */
async function catchUpSessionSummaryReports(args: {
  deps: SessionSummaryFoldRunnerDeps
  signal: AbortSignal
  ledger: SessionSummaryLedger
  foldParams: ResolvedSourceControlAiGenerationParams | null
}): Promise<SessionSummaryLedger> {
  // Why zero and not the cursor: no report at all means nothing has been reported, however far the
  // facts have been folded.
  const reported = args.ledger.reportFull?.through ?? 0
  if (reported >= args.ledger.foldedThrough) {
    return args.ledger
  }
  const reports = await rewriteSessionSummaryReports({
    brain: args.deps.createBrain(args.foldParams),
    signal: args.signal,
    ledger: args.ledger,
    folded: args.ledger,
    windowRestarted: false,
    userMessageCount: args.ledger.userMessageCount,
    lastUserMessageIndex: args.ledger.lastUserMessageIndex
  })
  return reports.full ? { ...args.ledger, reportFull: reports.full } : args.ledger
}

/**
 * Why a known session produced no events: the reader needs the difference between "this
 * session has not written a transcript yet" and "the transcript is not where its host said".
 */
function unavailableTranscriptReason(
  session: SessionSummarySessionRef,
  canReadTranscript: ((agentType: AgentType) => boolean) | undefined,
  kind: 'unreadable' | 'empty' = 'unreadable'
): string {
  const agent = session.agentType ?? 'agent'
  // Why first: "found nothing" is a claim about a search this build may never have run, and it
  // sends the reader looking for a file that a format it cannot decode would be in.
  if (session.agentType && canReadTranscript && !canReadTranscript(session.agentType)) {
    return `Orca has no transcript reader for ${agent} sessions yet.`
  }
  if (kind === 'empty') {
    return `The ${agent} session has no messages in its transcript yet.`
  }
  return session.providerSession?.transcriptPath
    ? `The ${agent} transcript this session reported is not readable here.`
    : `Orca could not locate this ${agent} session's transcript.`
}
