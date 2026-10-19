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
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import {
  runSessionSummaryFold,
  sessionSummaryIdentityOf,
  type SessionSummaryFoldRunnerDeps
} from './session-summary-fold-runner'
import type { SessionSummaryHostFoldClient } from './session-summary-host-fold-client'
import { SessionSummaryHostFoldSubscription } from './session-summary-host-subscription'
import {
  buildLocalSessionSummarySnapshot,
  IDLE_FOLD,
  type SessionSummaryStatusEntry
} from './session-summary-snapshot'
import type { SessionSummaryStoreEntry } from './session-summary-store'
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
  /** A host-owned pane's last snapshot: that host's ledger, seen cursor and progress. */
  hostSnapshot?: SessionSummarySnapshot
}

export class SessionSummaryService {
  private readonly folds = new Map<string, AbortController>()
  private readonly runtimes = new Map<string, PaneRuntime>()
  /** How many viewers hold each pane — two windows, or two paired clients on a host. */
  private readonly openRefs = new Map<string, number>()
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
    return buildLocalSessionSummarySnapshot({
      paneKey,
      entry: this.deps.getAgentStatusEntry(paneKey),
      ledger: stored?.ledger ?? null,
      messageCount: runtime?.messageCount ?? stored?.messageCount ?? 0,
      seenThrough: stored?.seenThrough ?? 0,
      status: runtime?.status,
      fold: runtime?.fold ?? IDLE_FOLD,
      ...(runtime?.error ? { error: runtime.error } : {})
    })
  }

  private emit(paneKey: string): void {
    const snapshot = this.snapshot(paneKey)
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  /** Returns the current snapshot immediately; fold work is async and pushed via onUpdate. */
  open(request: SessionSummaryOpenRequest): SessionSummarySnapshot {
    const paneKey = request.paneKey
    const entry = this.deps.getAgentStatusEntry(paneKey)
    const host = resolveSessionSummaryTranscriptHost({
      requestedHostId: request.executionHostId,
      connectionId: entry?.connectionId
    })
    const hasSource = Boolean(entry && entry.agentType && entry.providerSession?.id)
    // Reuse the live runtime: a fold in flight holds the old object and updates it.
    const runtime: PaneRuntime = this.runtimes.get(paneKey) ?? {
      status: 'folding',
      host,
      messageCount: 0,
      fold: IDLE_FOLD,
      foldParams: null
    }
    runtime.host = host
    // Re-open always (re)starts a fold: status is 'folding' until it settles,
    // even when a stale ledger is on display.
    runtime.status = this.initialStatus(host, hasSource)
    runtime.foldParams = request.foldParams ?? runtime.foldParams
    this.runtimes.set(paneKey, runtime)
    this.openRefs.set(paneKey, (this.openRefs.get(paneKey) ?? 0) + 1)
    this.resetStaleLedger(paneKey, host, entry)

    if (runtime.status !== 'folding') {
      return this.snapshot(paneKey)
    }
    if (host.kind === 'runtime') {
      this.startHostFold(paneKey, runtime, host.environmentId)
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
    entry: SessionSummaryStatusEntry | undefined
  ): void {
    if (host.kind === 'runtime') {
      return
    }
    const stored = this.deps.store.get(paneKey)
    // Why require an entry: this client clears status rows on reconnect, and an absent row
    // yields a null identity that differs from every stored one — deleting a good ledger.
    if (!stored || !entry) {
      return
    }
    if (this.identityChanged(stored.identity, sessionSummaryIdentityOf(entry))) {
      this.deps.store.delete(paneKey)
    }
  }

  /** Cancels in-flight fold work and advances the last-seen cursor to what was viewed. */
  close(request: SessionSummaryCloseRequest): void {
    const paneKey = request.paneKey
    // Why refcount: a second viewer of the same pane (a paired client on a host, or another
    // window) is still reading. Aborting here would end its fold and move its place in the
    // timeline on its behalf.
    const remaining = (this.openRefs.get(paneKey) ?? 1) - 1
    if (remaining > 0) {
      this.openRefs.set(paneKey, remaining)
      return
    }
    this.openRefs.delete(paneKey)
    const runtime = this.runtimes.get(paneKey)
    this.folds.get(paneKey)?.abort()
    this.folds.delete(paneKey)
    this.runtimes.delete(paneKey)
    // The host remembers what was seen for its own pane; the desktop holds no copy.
    if (runtime?.host.kind === 'runtime' && this.hostFolds) {
      this.hostFolds.close({
        paneKey,
        environmentId: runtime.host.environmentId,
        seenTimelineCount: request.seenTimelineCount
      })
      return
    }
    const stored = this.deps.store.get(paneKey)
    // Why: a session that never folded has nothing to remember. Writing an entry here
    // created a summary-less ledger that the next visit read as "Up to date" over an
    // empty body (#135).
    if (!stored) {
      return
    }
    this.deps.store.set(paneKey, {
      ...stored,
      seenThrough: Math.min(
        Math.max(0, Math.floor(request.seenTimelineCount)),
        stored.ledger.timeline.length
      ),
      updatedAt: this.deps.now()
    })
  }

  private identityChanged(
    a: SessionSummaryStoreEntry['identity'],
    b: SessionSummaryStoreEntry['identity']
  ): boolean {
    return a.providerSessionId !== b.providerSessionId || a.transcriptPath !== b.transcriptPath
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

  private startHostFold(paneKey: string, runtime: PaneRuntime, environmentId: string): void {
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
      lastSnapshot: runtime.hostSnapshot ?? null
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
