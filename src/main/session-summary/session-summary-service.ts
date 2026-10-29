// Orchestration for the session-summary materialized view. The summary is
// folded only while the user reads it: open() starts (or resumes) a fold,
// close() cancels it. Staleness facts are tracked for free at all times so
// laziness costs nothing but latency. See docs/reference/session-summary.md.
//
// A session on a paired Orca server is folded *there*, by that host's own instance
// of this class, and the desktop subscribes to its snapshots — the same code that
// would run if the user were working on that machine directly. A session on an SSH
// target folds here, from a fetched copy, because an SSH host runs no Orca server.
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type {
  SessionSummaryCloseRequest,
  SessionSummaryOpenRequest,
  SessionSummarySessionRef,
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { parseSessionSummarySessionRef } from '../../shared/session-summary-types'
import {
  mergeSessionRef,
  hasSessionRef,
  runSessionSummaryFold,
  sessionSummaryIdentityChanged,
  sessionSummaryIdentityOf,
  type SessionSummaryFoldRunnerDeps
} from './session-summary-fold-runner'
import type { SessionSummaryHostFoldClient } from './session-summary-host-fold-client'
import { SessionSummaryHostFoldSubscription } from './session-summary-host-subscription'
import { SessionSummaryPaneLeases } from './session-summary-pane-leases'
import {
  buildLocalSessionSummarySnapshot,
  IDLE_FOLD,
  type SessionSummaryStatusEntry
} from './session-summary-snapshot'
import { isStoredBriefReusable, attributableStoredLedger } from './session-summary-brief-freshness'
import { recordSessionSummarySeenCursor } from './session-summary-seen-cursor'
import {
  resolveSessionSummaryTranscriptHost,
  type SessionSummaryTranscriptHost
} from './session-summary-transcript-host'

export type { SessionSummaryStatusEntry }

export type SessionSummaryServiceDeps = SessionSummaryFoldRunnerDeps & {
  /** Present on the desktop; absent on a host, which folds its own sessions directly. */
  hostFold?: SessionSummaryHostFoldClient
  /**
   * The agent/model this window would fold with, from its own settings. A host fold is
   * spawned by that host, so the choice has to travel with the request — the host has no
   * idea what this desktop is configured for.
   */
  resolveFoldParams?: () => ResolvedSourceControlAiGenerationParams | null
  /** How often a host-owned fold is polled, in ms. Injected so tests need not wait. */
  hostPollIntervalMs?: number
}

type PaneRuntime = {
  status: SessionSummaryStatus
  host: SessionSummaryTranscriptHost
  error?: string
  messageCount: number
  fold: SessionSummarySnapshot['fold']
  foldParams: ResolvedSourceControlAiGenerationParams | null
  /** The viewer's own record of which session this pane holds, when the request carried it. */
  identity?: SessionSummarySessionRef
  /** A host-owned pane's last snapshot: that host's ledger, seen cursor and progress. */
  hostSnapshot?: SessionSummarySnapshot
}

export class SessionSummaryService {
  private readonly folds = new Map<string, AbortController>()
  private readonly runtimes = new Map<string, PaneRuntime>()
  private readonly leases = new SessionSummaryPaneLeases()
  private readonly listeners = new Set<(snapshot: SessionSummarySnapshot) => void>()
  private readonly hostFolds: SessionSummaryHostFoldSubscription | null

  constructor(private readonly deps: SessionSummaryServiceDeps) {
    this.hostFolds = deps.hostFold
      ? new SessionSummaryHostFoldSubscription({
          hostFold: deps.hostFold,
          ...(deps.hostPollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: deps.hostPollIntervalMs }),
          onSnapshot: (paneKey, snapshot) => this.applyHostSnapshot(paneKey, snapshot),
          onError: (paneKey, error, snapshot) => this.failHostFold(paneKey, error, snapshot)
        })
      : null
  }

  onUpdate(listener: (snapshot: SessionSummarySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The current snapshot without starting, restarting, or cancelling any work. */
  peek(paneKey: string): SessionSummarySnapshot {
    return this.snapshot(paneKey)
  }

  private snapshot(paneKey: string): SessionSummarySnapshot {
    const runtime = this.runtimes.get(paneKey)
    // A host-owned pane's ledger, cursor and progress belong to that host: relaying its
    // snapshot keeps one source of truth instead of a second copy that can drift.
    if (runtime?.hostSnapshot) {
      return runtime.hostSnapshot
    }
    const stored = this.deps.store.get(paneKey)
    const entry = this.deps.getAgentStatusEntry(paneKey)
    const ledger = attributableStoredLedger(stored, entry, runtime?.identity)
    return buildLocalSessionSummarySnapshot({
      paneKey,
      entry,
      ledger,
      messageCount: runtime?.messageCount ?? stored?.messageCount ?? 0,
      seenThrough: stored?.seenThrough ?? 0,
      // Why undefined when withheld: the builder infers "unavailable" for a pane with no ledger, and a
      // withheld brief reported as "ready" is the blank body that reads as up to date.
      status: ledger === null && runtime?.status === 'ready' ? undefined : runtime?.status,
      fold: runtime?.fold ?? IDLE_FOLD,
      ...(runtime?.error ? { error: runtime.error } : {})
    })
  }

  private emit(paneKey: string): void {
    const snapshot = this.snapshot(paneKey)
    this.listeners.forEach((listener) => listener(snapshot))
  }

  /** Returns the current snapshot immediately; fold work is async and pushed via onUpdate. */
  open(request: SessionSummaryOpenRequest): SessionSummarySnapshot {
    const paneKey = request.paneKey
    const entry = this.deps.getAgentStatusEntry(paneKey)
    const host = resolveSessionSummaryTranscriptHost({
      requestedHostId: request.executionHostId,
      connectionId: entry?.connectionId
    })
    // Why the request is merged in: the viewer holds the pane, so it can name the session even
    // when the folding side's row is missing or relayed without a transcript path — the case
    // that reported "no readable transcript" for a live session. Where this process does hold a
    // row naming a session, that row still wins: it is its own latest evidence, and a lagging
    // client id would otherwise brief the previous conversation (#135).
    const identity = mergeSessionRef(parseSessionSummarySessionRef(request.session), entry)
    const hasSource = Boolean(identity.agentType && identity.providerSession?.id)
    // Reuse the live runtime: a fold in flight holds the old object and updates it.
    const runtime: PaneRuntime = this.runtimes.get(paneKey) ?? {
      status: 'folding',
      host,
      messageCount: 0,
      fold: IDLE_FOLD,
      foldParams: null
    }
    runtime.host = host
    // Why not carried over: params belong to the open that sent them. A paired client's
    // choice must not survive into this window's next fold of the same pane.
    runtime.foldParams = request.foldParams ?? null
    // Why cleared: a fresh open must not inherit the previous fold's complaint, which would
    // otherwise sit under a brief that has since succeeded.
    runtime.error = undefined
    runtime.identity = hasSessionRef(identity) ? identity : undefined
    // Why one lease per viewer, not per request: a refresh or an hourly auto-fold is the same
    // reader asking again. Taking a lease for it would outlive the single close an unmount
    // sends, and the pane's cancel-on-close would never fire.
    if (!request.sameViewer) {
      this.leases.touch(paneKey)
    }
    // Why before the freshness check: a ledger that belongs to a different conversation must be
    // dropped before anything decides it is fresh enough to show.
    this.resetStaleLedger(paneKey, host, identity)
    runtime.status = this.initialStatus(host, hasSource)
    this.runtimes.set(paneKey, runtime)

    // Why: re-entering the pane is not a request to spend a model call again. A brief that is
    // younger than the caller's freshness window, or a row that has not been updated since the
    // fold, already answers the question the reader came back for.
    if (
      host.kind !== 'runtime' &&
      !runtime.fold.running &&
      isStoredBriefReusable({
        revalidateWithinMs: request.revalidateWithinMs,
        foldedAt: this.deps.store.get(paneKey)?.ledger.foldedAt,
        storedIdentity: this.deps.store.get(paneKey)?.identity,
        currentIdentity: sessionSummaryIdentityOf(identity),
        entry,
        now: this.deps.now()
      })
    ) {
      runtime.status = 'ready'
      runtime.fold = IDLE_FOLD
      runtime.hostSnapshot = undefined
      this.emit(paneKey)
      return this.snapshot(paneKey)
    }
    // A host this build cannot place, or an agent with no transcript at all: nothing to fold.
    if (runtime.status !== 'folding') {
      return this.snapshot(paneKey)
    }
    if (host.kind === 'runtime') {
      this.startHostFold(paneKey, runtime, host.environmentId, request)
    } else if (!this.folds.has(paneKey)) {
      void this.runLocalFold(paneKey, host)
    }
    return this.snapshot(paneKey)
  }

  private initialStatus(
    host: SessionSummaryTranscriptHost,
    hasSource: boolean
  ): SessionSummaryStatus {
    if (host.kind === 'unsupported') {
      return 'unsupported-host'
    }
    // Why not gated on a local row: a paired host keeps the status rows for its own
    // sessions, and this client's copies are cleared on reconnect. Asking the host is how
    // a pane whose row was dropped still gets its summary (#135).
    return host.kind === 'runtime' || hasSource ? 'folding' : 'unavailable'
  }

  /**
   * Drops a ledger that describes a different conversation. A host-owned pane's ledger is
   * that host's cache, so this store never describes it at all.
   */
  private resetStaleLedger(
    paneKey: string,
    host: SessionSummaryTranscriptHost,
    identity: SessionSummarySessionRef
  ): void {
    if (host.kind === 'runtime') {
      return
    }
    const stored = this.deps.store.get(paneKey)
    // Why require an identity: this client clears status rows on reconnect, and an absent
    // one yields a null identity that differs from every stored one — deleting a good ledger.
    if (!stored || !identity.providerSession?.id) {
      return
    }
    if (sessionSummaryIdentityChanged(stored.identity, sessionSummaryIdentityOf(identity))) {
      this.deps.store.delete(paneKey)
    }
  }

  /** Cancels in-flight fold work and advances the last-seen cursor to what was viewed. */
  close(request: SessionSummaryCloseRequest): void {
    const paneKey = request.paneKey
    const runtime = this.runtimes.get(paneKey)
    // Forwarded on every close; the subscription turns them into exactly one host close per
    // accepted open, which is what ends that fold.
    if (runtime?.host.kind === 'runtime' && this.hostFolds) {
      this.hostFolds.close({
        paneKey,
        environmentId: runtime.host.environmentId,
        seenTimelineCount: request.seenTimelineCount,
        lastViewer: this.leases.count(paneKey) <= 1
      })
    }
    // Recorded on every close, whoever else still holds the pane: the reader who reached
    // furthest keeps their place even if another viewer never returns its lease.
    recordSessionSummarySeenCursor({
      store: this.deps.store,
      paneKey,
      seenTimelineCount: request.seenTimelineCount,
      hostOwnsCursor: runtime?.host.kind === 'runtime',
      now: this.deps.now()
    })
    // Why refcount: a second viewer is still reading, and aborting would end its fold too.
    if (this.leases.release(paneKey) > 0) {
      // Another viewer is still reading: leave its fold and its polling alone.
      return
    }
    this.releasePane(paneKey)
  }

  /** Drops every lease on the pane and stops its work. */
  private releasePane(paneKey: string): void {
    this.leases.drop(paneKey)
    // Stops the host polling too: the last viewer is gone, so nothing needs those answers.
    this.hostFolds?.cancel(paneKey)
    this.folds.get(paneKey)?.abort()
    this.folds.delete(paneKey)
    this.runtimes.delete(paneKey)
  }

  private runLocalFold(paneKey: string, host: SessionSummaryTranscriptHost): Promise<void> {
    const controller = new AbortController()
    this.folds.set(paneKey, controller)
    const runtime = this.runtimes.get(paneKey)
    // Why: the fold is in flight from here, before the transcript read resolves.
    // Without this the header read "Up to date" for the whole first fold, because
    // progress only arrives once a chunk comes back.
    if (runtime) {
      runtime.fold = { running: true, completedChunks: 0, totalChunks: 0 }
    }
    return runSessionSummaryFold({
      deps: this.deps,
      paneKey,
      host,
      ...(runtime?.identity ? { requestedSession: runtime.identity } : {}),
      foldParams: runtime?.foldParams ?? null,
      signal: controller.signal,
      callbacks: {
        onStatus: (update) => {
          if (runtime) {
            runtime.status = update.status
            runtime.fold = update.fold
            if (update.messageCount !== undefined) {
              runtime.messageCount = update.messageCount
            }
            if (update.error) {
              runtime.error = update.error
            }
          }
          this.emit(paneKey)
        }
      }
    }).finally(() => {
      if (this.folds.get(paneKey) === controller) {
        this.folds.delete(paneKey)
      }
    })
  }

  private startHostFold(
    paneKey: string,
    runtime: PaneRuntime,
    environmentId: string,
    request: SessionSummaryOpenRequest
  ): void {
    if (!this.hostFolds) {
      // A host never folds for a pane it does not own, so this is a build without the
      // paired-host bridge rather than a failure of this session.
      runtime.status = 'unsupported-host'
      this.emit(paneKey)
      return
    }
    // Why mark the fold running: until the host answers, an idle fold reads as
    // "Up to date" over a skeleton, which is the empty state #135 is about.
    runtime.fold = { running: true, completedChunks: 0, totalChunks: 0 }
    this.hostFolds.open({
      paneKey,
      environmentId,
      foldParams: runtime.foldParams ?? this.deps.resolveFoldParams?.() ?? null,
      // Why forwarded: the host owns its own brief cache, so only the host can decide whether
      // the brief the reader is coming back to is fresh enough — and only the host can tell a
      // refresh from a second viewer, which is what keeps its lease count honest.
      ...(request.revalidateWithinMs && request.revalidateWithinMs > 0
        ? { revalidateWithinMs: request.revalidateWithinMs }
        : {}),
      ...(request.sameViewer ? { sameViewer: true } : {}),
      // Why send it: the host's own row for this pane may be absent (the client owns the
      // layout) or relayed without a transcript path, and a host that cannot read its row
      // answered "no readable transcript" for a session it was running the whole time.
      ...(runtime.identity ? { session: runtime.identity } : {})
    })
  }

  private applyHostSnapshot(paneKey: string, snapshot: SessionSummarySnapshot): void {
    const runtime = this.runtimes.get(paneKey)
    if (!runtime) {
      return
    }
    runtime.hostSnapshot = snapshot
    runtime.status = snapshot.status
    this.emit(paneKey)
  }

  private failHostFold(
    paneKey: string,
    error: Error,
    snapshot: SessionSummarySnapshot | null
  ): void {
    const runtime = this.runtimes.get(paneKey)
    if (!runtime) {
      return
    }
    runtime.status = 'failed'
    runtime.error = error.message
    // Keep the last good brief on screen; the header and body report the failure.
    runtime.hostSnapshot = {
      ...(snapshot ?? {
        paneKey,
        status: 'failed' as const,
        facts: null,
        ledger: null,
        seenThrough: 0,
        fold: IDLE_FOLD
      }),
      status: 'failed',
      error: error.message
    }
    this.emit(paneKey)
  }
}
