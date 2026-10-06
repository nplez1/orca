// Orchestration for the session-summary materialized view. The summary is
// folded only while the user reads it: open() starts (or resumes) a fold,
// close() cancels it. Staleness facts are tracked for free at all times so
// laziness costs nothing but latency. See docs/reference/session-summary.md.
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type {
  SessionSummaryCloseRequest,
  SessionSummaryFacts,
  SessionSummaryLedger,
  SessionSummaryOpenRequest,
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { emptySessionSummaryLedger } from './session-summary-ledger'
import {
  foldSessionSummaryEvents,
  type SessionFoldBrain,
  type SessionSummaryChunkCache,
  type SessionSummaryFoldResult,
  type SessionSummarySourceEvent
} from './session-summary-fold'
import type { SessionSummaryStore, SessionSummaryStoreEntry } from './session-summary-store'
import type { SessionSummarySessionIdentity } from './session-summary-transcript-source'

// The subset of a status row the summary needs; optional throughout because
// hook rows arrive from hosts of varying vintage (see agent-status-types.ts).
export type SessionSummaryStatusEntry = {
  agentType?: AgentType
  providerSession?: AgentProviderSessionMetadata
  state?: AgentStatusState
  stateStartedAt?: number
  turnStartedAt?: number
  updatedAt?: number
  prompt?: string
}

export type SessionSummaryServiceDeps = {
  store: SessionSummaryStore
  readEvents: (args: {
    identity: SessionSummarySessionIdentity
    signal: AbortSignal
  }) => Promise<SessionSummarySourceEvent[] | null>
  getAgentStatusEntry: (paneKey: string) => SessionSummaryStatusEntry | undefined
  createBrain: (params: ResolvedSourceControlAiGenerationParams | null) => SessionFoldBrain
  now: () => number
}

type PaneRuntime = {
  status: SessionSummaryStatus
  error?: string
  messageCount: number
  fold: { running: boolean; completedChunks: number; totalChunks: number }
  foldParams: ResolvedSourceControlAiGenerationParams | null
}

function identityOf(
  entry: SessionSummaryStatusEntry | undefined
): SessionSummaryStoreEntry['identity'] {
  return {
    providerSessionId: entry?.providerSession?.id ?? null,
    transcriptPath: entry?.providerSession?.transcriptPath ?? null
  }
}

export class SessionSummaryService {
  private readonly folds = new Map<string, AbortController>()
  private readonly runtimes = new Map<string, PaneRuntime>()
  private readonly listeners = new Set<(snapshot: SessionSummarySnapshot) => void>()

  constructor(private readonly deps: SessionSummaryServiceDeps) {}

  onUpdate(listener: (snapshot: SessionSummarySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Cheap deterministic facts: no LLM, no transcript read. */
  private buildFacts(
    paneKey: string,
    entry: SessionSummaryStatusEntry | undefined,
    ledger: SessionSummaryLedger,
    messageCount: number
  ): SessionSummaryFacts {
    return {
      paneKey,
      ...(entry?.agentType ? { agentType: entry.agentType } : {}),
      ...(entry?.state ? { state: entry.state } : {}),
      ...(entry?.stateStartedAt ? { stateStartedAt: entry.stateStartedAt } : {}),
      ...(entry?.turnStartedAt ? { turnStartedAt: entry.turnStartedAt } : {}),
      ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      prompt: entry?.prompt ?? '',
      messageCount,
      foldedThrough: ledger.foldedThrough,
      backlogCount: Math.max(0, messageCount - ledger.foldedThrough)
    }
  }

  private snapshot(paneKey: string): SessionSummarySnapshot {
    const entry = this.deps.getAgentStatusEntry(paneKey)
    const stored = this.deps.store.get(paneKey)
    const runtime = this.runtimes.get(paneKey)
    const ledger = stored?.ledger ?? null
    const messageCount = runtime?.messageCount ?? stored?.messageCount ?? 0
    return {
      paneKey,
      status: runtime?.status ?? (ledger ? 'ready' : 'unavailable'),
      facts: this.buildFacts(paneKey, entry, ledger ?? emptySessionSummaryLedger(), messageCount),
      ledger,
      seenThrough: stored?.seenThrough ?? 0,
      fold: runtime?.fold ?? { running: false, completedChunks: 0, totalChunks: 0 },
      ...(runtime?.error ? { error: runtime.error } : {})
    }
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
    const identity = identityOf(entry)
    const hasSource = Boolean(entry && entry.agentType && entry.providerSession?.id)
    // Reuse the live runtime: a fold in flight holds the old object and updates it.
    const runtime: PaneRuntime = this.runtimes.get(paneKey) ?? {
      status: 'folding',
      messageCount: 0,
      fold: { running: false, completedChunks: 0, totalChunks: 0 },
      foldParams: null
    }
    // Re-open always (re)starts a fold: status is 'folding' until it settles,
    // even when a stale ledger is on display.
    runtime.status = hasSource ? 'folding' : 'unavailable'
    runtime.foldParams = request.foldParams ?? runtime.foldParams
    this.runtimes.set(paneKey, runtime)

    const stored = this.deps.store.get(paneKey)
    if (stored && this.identityChanged(stored.identity, identity)) {
      // New session on this paneKey: yesterday's ledger describes a different conversation.
      this.deps.store.set(paneKey, freshStoreEntry(identity, this.deps.now()))
    }

    if (hasSource && !this.folds.has(paneKey)) {
      void this.runFold(paneKey)
    }
    return this.snapshot(paneKey)
  }

  /** Cancels in-flight fold work and advances the last-seen cursor to what was viewed. */
  close(request: SessionSummaryCloseRequest): void {
    const paneKey = request.paneKey
    this.folds.get(paneKey)?.abort()
    this.folds.delete(paneKey)
    this.runtimes.delete(paneKey)
    const identity = identityOf(this.deps.getAgentStatusEntry(paneKey))
    const stored = this.ensureStoredEntry(paneKey, identity)
    const seenThrough = Math.min(
      Math.max(0, Math.floor(request.seenTimelineCount)),
      stored.ledger.timeline.length
    )
    this.deps.store.set(paneKey, { ...stored, seenThrough, updatedAt: this.deps.now() })
  }

  private identityChanged(
    a: SessionSummaryStoreEntry['identity'],
    b: SessionSummaryStoreEntry['identity']
  ): boolean {
    return a.providerSessionId !== b.providerSessionId || a.transcriptPath !== b.transcriptPath
  }

  private async runFold(paneKey: string): Promise<void> {
    const controller = new AbortController()
    this.folds.set(paneKey, controller)
    const runtime = this.runtimes.get(paneKey)
    try {
      const entry = this.deps.getAgentStatusEntry(paneKey)
      const identity = identityOf(entry)
      const events = await this.deps.readEvents({
        identity: {
          ...(entry?.agentType ? { agentType: entry.agentType } : {}),
          ...(entry?.providerSession ? { providerSession: entry.providerSession } : {})
        },
        signal: controller.signal
      })
      controller.signal.throwIfAborted()
      if (!events) {
        if (runtime) {
          runtime.status = 'unavailable'
          runtime.fold = { running: false, completedChunks: 0, totalChunks: 0 }
        }
        this.emit(paneKey)
        return
      }
      const stored = this.ensureStoredEntry(paneKey, identity)
      const foldedThrough = stored.ledger.foldedThrough
      const newEvents = events.slice(foldedThrough)
      if (runtime) {
        runtime.messageCount = events.length
      }
      if (newEvents.length === 0) {
        if (runtime) {
          // No readable content yet is 'unavailable', not a summary of nothing.
          runtime.status = events.length === 0 ? 'unavailable' : 'ready'
          runtime.fold = { running: false, completedChunks: 0, totalChunks: 0 }
        }
        this.persist(paneKey, identity, stored, events.length)
        this.emit(paneKey)
        return
      }

      const cache = this.chunkCacheFor(stored)
      const result = await foldSessionSummaryEvents({
        brain: this.deps.createBrain(runtime?.foldParams ?? null),
        ledger: stored.ledger,
        events: newEvents,
        signal: controller.signal,
        cache,
        onProgress: (progress: SessionSummaryFoldResult) => {
          if (runtime) {
            runtime.fold = {
              running: true,
              completedChunks: progress.completedChunks,
              totalChunks: progress.totalChunks
            }
          }
          this.emit(paneKey)
        }
      })
      controller.signal.throwIfAborted()
      if (runtime) {
        runtime.status = 'ready'
        runtime.fold = {
          running: false,
          completedChunks: result.completedChunks,
          totalChunks: result.totalChunks
        }
      }
      this.persist(paneKey, identity, { ...stored, ledger: result.ledger }, events.length)
      this.emit(paneKey)
    } catch (error) {
      if (controller.signal.aborted) {
        return // Pane closed: cancel-on-close, nothing to report.
      }
      if (runtime) {
        runtime.status = 'failed'
        runtime.error = error instanceof Error ? error.message : String(error)
        runtime.fold = { running: false, completedChunks: 0, totalChunks: 0 }
      }
      // Completed chunk extracts survive the failure so a retry resumes, not restarts.
      const failedIdentity = identityOf(this.deps.getAgentStatusEntry(paneKey))
      const failedStored = this.ensureStoredEntry(paneKey, failedIdentity)
      this.persist(paneKey, failedIdentity, failedStored, failedStored.messageCount)
      this.emit(paneKey)
    } finally {
      if (this.folds.get(paneKey) === controller) {
        this.folds.delete(paneKey)
      }
    }
  }

  private ensureStoredEntry(
    paneKey: string,
    identity: SessionSummaryStoreEntry['identity']
  ): SessionSummaryStoreEntry {
    return this.deps.store.get(paneKey) ?? freshStoreEntry(identity, this.deps.now())
  }

  private chunkCacheFor(stored: SessionSummaryStoreEntry): SessionSummaryChunkCache {
    return {
      get: (key) => stored.chunkCache[key],
      set: (key, delta) => {
        stored.chunkCache[key] = delta
      }
    }
  }

  private persist(
    paneKey: string,
    identity: SessionSummaryStoreEntry['identity'],
    stored: SessionSummaryStoreEntry,
    messageCount: number
  ): void {
    // Chunk extracts covered by the new foldedThrough are already applied; drop them.
    const chunkCache: SessionSummaryStoreEntry['chunkCache'] = {}
    for (const [key, delta] of Object.entries(stored.chunkCache)) {
      const from = Number.parseInt(key.split('-')[0] ?? '', 10)
      if (Number.isFinite(from) && from >= stored.ledger.foldedThrough) {
        chunkCache[key] = delta
      }
    }
    this.deps.store.set(paneKey, {
      identity,
      ledger: stored.ledger,
      chunkCache,
      messageCount,
      seenThrough: stored.seenThrough,
      updatedAt: this.deps.now()
    })
  }
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
