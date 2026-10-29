// One fold, end to end: read the transcript, fold it in bounded chunks, persist the result.
//
// Kept out of the service so the service stays the lazy-lifecycle layer (open/close and
// which host folds) while this is the chapter that can fail: a transcript read, a model
// extract, or a write. Nothing is applied on failure, and completed chunk extracts are
// kept so a retry resumes instead of restarting.
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentType } from '../../shared/agent-status-types'
import type {
  SessionSummarySessionRef,
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { emptySessionSummaryLedger, hasProducedLedger } from './session-summary-ledger'
import {
  foldSessionSummaryEvents,
  type SessionFoldBrain,
  type SessionSummaryChunkCache
} from './session-summary-fold'
import { IDLE_FOLD, type SessionSummaryStatusEntry } from './session-summary-snapshot'
import { withSessionSummaryFoldSlot } from './session-summary-fold-slots'
import type { SessionSummaryStore, SessionSummaryStoreEntry } from './session-summary-store'
import type {
  SessionSummaryEventRead,
  SessionSummarySessionIdentity
} from './session-summary-transcript-source'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

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
  }) => void
}

export function sessionSummaryIdentityOf(
  entry: SessionSummarySessionRef | undefined
): SessionSummaryStoreEntry['identity'] {
  return {
    providerSessionId: entry?.providerSession?.id ?? null,
    transcriptPath: entry?.providerSession?.transcriptPath ?? null
  }
}

/**
 * The identity a fold should use: this process's own row, with the viewer's request filling
 * what the row cannot say.
 *
 * Why the request is a filler and not an override: the viewer is the one process guaranteed
 * to know *which* session the reader is looking at, which is exactly what a paired host or a
 * reconnected client was missing when it answered "no readable transcript" for a live
 * session. But where this process holds a row that names a session, that row is its own
 * latest evidence (hooks land here), and letting a lagging client id override it would brief
 * the previous conversation — the failure #135 is about.
 */
export function mergeSessionRef(
  requested: SessionSummarySessionRef | null | undefined,
  entry: SessionSummarySessionRef | undefined
): SessionSummarySessionRef {
  const chosen = mergeProviderSession(entry?.providerSession, requested?.providerSession)
  // Why paired with its session: an agent type from one side next to a session from the other
  // describes a conversation neither side has — Pi's transcript read with Claude's parser — so
  // the type always comes from whichever side supplied the session.
  const agentType = chosen.fromEntry
    ? (entry?.agentType ?? requested?.agentType)
    : (requested?.agentType ?? entry?.agentType)
  return {
    ...(agentType ? { agentType } : {}),
    ...(chosen.providerSession ? { providerSession: chosen.providerSession } : {})
  }
}

/** The row's session when it names one; its missing transcript path from the request. */
function mergeProviderSession(
  local: AgentProviderSessionMetadata | undefined,
  requested: AgentProviderSessionMetadata | undefined
): { providerSession: AgentProviderSessionMetadata | undefined; fromEntry: boolean } {
  if (!local) {
    return { providerSession: requested, fromEntry: false }
  }
  if (local.transcriptPath || !requested?.transcriptPath || requested.id !== local.id) {
    return { providerSession: local, fromEntry: true }
  }
  return {
    providerSession: { ...local, transcriptPath: requested.transcriptPath },
    fromEntry: true
  }
}

/**
 * Whether two stored identities describe different conversations.
 *
 * A side without a transcript path knows less, it does not know something different: treating a
 * missing path as a change dropped a good ledger and its seen cursor whenever the identity came
 * from a request that named only the session id.
 */
export function sessionSummaryIdentityChanged(
  a: SessionSummaryStoreEntry['identity'],
  b: SessionSummaryStoreEntry['identity']
): boolean {
  if (a.providerSessionId !== b.providerSessionId) {
    return true
  }
  if (!a.transcriptPath || !b.transcriptPath) {
    return false
  }
  return a.transcriptPath !== b.transcriptPath
}

export function hasSessionRef(ref: SessionSummarySessionRef): boolean {
  return Boolean(ref.agentType || ref.providerSession)
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
    // Completed chunk extracts survive a failure — but only once a fold has produced a
    // ledger, since an unproduced one is never written. A first fold's chunks are lost.
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
    // Persist first: the snapshot a listener receives reads the store, so reporting
    // 'ready' before the write showed a ready status over an absent ledger.
    persist(deps, paneKey, identity, stored, messageCount)
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
    onProgress: (progress) =>
      report({
        status: 'folding',
        fold: {
          running: true,
          completedChunks: progress.completedChunks,
          totalChunks: progress.totalChunks
        },
        messageCount
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
    messageCount
  })
}

function storedEntry(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity']
): SessionSummaryStoreEntry {
  return deps.store.get(paneKey) ?? freshStoreEntry(identity, deps.now())
}

function chunkCacheFor(stored: SessionSummaryStoreEntry): SessionSummaryChunkCache {
  return {
    get: (key) => stored.chunkCache[key],
    set: (key, delta) => {
      stored.chunkCache[key] = delta
    }
  }
}

function persist(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity'],
  stored: SessionSummaryStoreEntry,
  messageCount: number
): void {
  // Why: nothing folded yet means there is no summary to remember, and recording an
  // empty ledger is what made the next visit claim "Up to date" over a blank body (#135).
  if (!hasProducedLedger(stored.ledger)) {
    return
  }
  // Chunk extracts covered by the new foldedThrough are already applied; drop them.
  const chunkCache: SessionSummaryStoreEntry['chunkCache'] = {}
  for (const [key, delta] of Object.entries(stored.chunkCache)) {
    const from = Number.parseInt(key.split('-')[0] ?? '', 10)
    if (Number.isFinite(from) && from >= stored.ledger.foldedThrough) {
      chunkCache[key] = delta
    }
  }
  deps.store.set(paneKey, {
    identity,
    ledger: stored.ledger,
    chunkCache,
    messageCount,
    seenThrough: stored.seenThrough,
    updatedAt: deps.now()
  })
}

function freshStoreEntry(
  identity: SessionSummaryStoreEntry['identity'],
  now: number
): SessionSummaryStoreEntry {
  return {
    identity,
    ledger: emptySessionSummaryLedger(),
    chunkCache: {},
    messageCount: 0,
    seenThrough: 0,
    updatedAt: now
  }
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
