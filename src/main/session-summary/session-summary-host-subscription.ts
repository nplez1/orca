// A fold that runs on the paired host owning the session, and the polling that keeps the
// pane current with it.
//
// This module owns every paired-host lease. An open the host accepts is a lease owed one
// close, and the count lives here because opens answer asynchronously: a viewer can close a
// pane before its open has been answered, and a close that arrives too early must not be
// dropped (the lease would live on and its fold would never stop) nor sent (the host may yet
// reject the open, and closing a lease that does not exist takes another client's).
//
// Polling rather than a held-open call or a stream: a fold of a long session outlives a relay
// idle window, "still running? / what is the ledger now?" is all the pane needs, and a
// reconnecting client resumes against the same host state with nothing to tear down.
import type { SessionSummaryHostFoldClient } from './session-summary-host-fold-client'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'

const DEFAULT_POLL_INTERVAL_MS = 600
const MAX_POLL_RETRIES = 1

export type SessionSummaryHostSubscriptionDeps = {
  hostFold: SessionSummaryHostFoldClient
  pollIntervalMs?: number
  /** The host answered with a newer snapshot for the pane's current view. */
  onSnapshot: (paneKey: string, snapshot: SessionSummarySnapshot) => void
  /** The open or a poll failed; `snapshot` is passed through when one was already shown. */
  onError: (paneKey: string, error: Error, snapshot: SessionSummarySnapshot | null) => void
}

type InflightOpen = { environmentId: string; queuedClose: number | null }

type PaneHostState = {
  /** Never reset: a late answer from a closed chain must not match a later open's number. */
  nextSeq: number
  token: number
  environmentId: string
  inflight: Map<number, InflightOpen>
  /** Opens the host accepted and no close has been sent for. */
  leases: number
  /**
   * Viewers whose open never became a lease, so their close is spent here.
   *
   * Without it a failed open's close would spend the next lease in line — which belongs to
   * another viewer — and stop that viewer's fold on the host.
   */
  unleasedViewers: number
  /**
   * The furthest point an absorbed close reported, carried into the next close this pane
   * sends. The host owns the cursor, so a close spent against a failed open would otherwise
   * drop its viewer's place on the timeline.
   */
  pendingSeen: number
  latest?: SessionSummarySnapshot
  pollFailures: number
}

export class SessionSummaryHostFoldSubscription {
  private readonly panes = new Map<string, PaneHostState>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: SessionSummaryHostSubscriptionDeps) {}

  /** Starts (or restarts) a host fold for the pane. */
  open(args: {
    paneKey: string
    environmentId: string
    foldParams: ResolvedSourceControlAiGenerationParams | null
  }): void {
    const state = this.stateFor(args.paneKey, args.environmentId)
    const seq = state.nextSeq
    state.nextSeq += 1
    state.token += 1
    state.inflight.set(seq, { environmentId: args.environmentId, queuedClose: null })
    this.clearTimer(args.paneKey)
    void this.runOpen(args, state, seq, state.token)
  }

  /**
   * Tells the host what the viewer saw, and stops watching when they were the last one.
   *
   * Every open the host accepted owes exactly one close, so this goes to the host whenever a
   * lease is outstanding. A close with no lease yet waits behind the oldest unanswered open,
   * because that is the lease it is owed.
   */
  close(args: {
    paneKey: string
    environmentId: string
    seenTimelineCount: number
    lastViewer: boolean
  }): void {
    const state = this.panes.get(args.paneKey)
    if (!state) {
      // Nothing was ever opened here: nothing to close, and nothing to stop.
      return
    }
    if (state.unleasedViewers > 0) {
      // This viewer's own open failed: it owes the host nothing, and must not spend a lease
      // that another viewer is reading through. Its place is still owed to the host, so it
      // rides along with the next close this pane sends.
      state.unleasedViewers -= 1
      state.pendingSeen = Math.max(state.pendingSeen, args.seenTimelineCount)
    } else if (state.leases > 0) {
      state.leases -= 1
      this.sendClose({ ...args, seenTimelineCount: this.takeSeen(state, args.seenTimelineCount) })
    } else {
      const waiting = [...state.inflight.values()].find((open) => open.queuedClose === null)
      if (waiting) {
        waiting.queuedClose = Math.max(waiting.queuedClose ?? 0, args.seenTimelineCount)
      }
    }
    if (args.lastViewer) {
      this.cancel(args.paneKey)
    }
  }

  /** Stops watching the pane, without touching the leases the host holds. */
  cancel(paneKey: string): void {
    const state = this.panes.get(paneKey)
    if (state) {
      state.token += 1
    }
    this.clearTimer(paneKey)
  }

  private stateFor(paneKey: string, environmentId: string): PaneHostState {
    const existing = this.panes.get(paneKey)
    if (existing) {
      existing.environmentId = environmentId
      return existing
    }
    const created: PaneHostState = {
      nextSeq: 1,
      token: 1,
      environmentId,
      inflight: new Map(),
      leases: 0,
      unleasedViewers: 0,
      pendingSeen: 0,
      pollFailures: 0
    }
    this.panes.set(paneKey, created)
    return created
  }

  private async runOpen(
    args: {
      paneKey: string
      environmentId: string
      foldParams: ResolvedSourceControlAiGenerationParams | null
    },
    state: PaneHostState,
    seq: number,
    token: number
  ): Promise<void> {
    try {
      const snapshot = await this.deps.hostFold.open({
        environmentId: args.environmentId,
        paneKey: args.paneKey,
        foldParams: args.foldParams
      })
      const queued = state.inflight.get(seq)?.queuedClose ?? null
      state.inflight.delete(seq)
      // Why count before checking currency: the host took this lease whatever this pane is
      // showing now, and a lease nobody accounts for is a fold nobody can stop.
      state.leases += 1
      if (queued !== null) {
        state.leases -= 1
        this.sendClose({
          paneKey: args.paneKey,
          environmentId: args.environmentId,
          seenTimelineCount: this.takeSeen(state, queued)
        })
      }
      this.accept(args.paneKey, state, token, snapshot)
    } catch (error) {
      // No lease was taken, so this viewer's close owes the host nothing — remembering that
      // keeps it from spending a lease another viewer is reading through.
      const pending = state.inflight.get(seq)
      state.inflight.delete(seq)
      if (pending?.queuedClose == null) {
        state.unleasedViewers += 1
      } else {
        // The queued close was already paid against this open, so it settles here. Its place
        // on the timeline still belongs to the host.
        state.pendingSeen = Math.max(state.pendingSeen, pending.queuedClose)
      }
      this.fail(args.paneKey, state, token, error)
    }
  }

  private accept(
    paneKey: string,
    state: PaneHostState,
    token: number,
    snapshot: SessionSummarySnapshot
  ): void {
    if (state.token !== token) {
      return
    }
    state.latest = snapshot
    state.pollFailures = 0
    this.deps.onSnapshot(paneKey, snapshot)
    this.schedule(paneKey, state, token)
  }

  private schedule(paneKey: string, state: PaneHostState, token: number): void {
    if (!state.latest?.fold.running) {
      return
    }
    this.clearTimer(paneKey)
    this.timers.set(
      paneKey,
      setTimeout(() => {
        this.timers.delete(paneKey)
        void this.poll(paneKey, state, token)
      }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    )
  }

  private async poll(paneKey: string, state: PaneHostState, token: number): Promise<void> {
    if (state.token !== token) {
      return
    }
    try {
      const snapshot = await this.deps.hostFold.peek({
        environmentId: state.environmentId,
        paneKey
      })
      this.accept(paneKey, state, token, snapshot)
    } catch (error) {
      // Why one retry: a relay blip must not freeze a stale brief under "Up to date".
      state.pollFailures += 1
      if (state.pollFailures <= MAX_POLL_RETRIES && state.token === token) {
        this.schedule(paneKey, state, token)
        return
      }
      this.fail(paneKey, state, token, error)
    }
  }

  private fail(paneKey: string, state: PaneHostState, token: number, error: unknown): void {
    if (state.token !== token) {
      return
    }
    this.clearTimer(paneKey)
    this.deps.onError(
      paneKey,
      error instanceof Error ? error : new Error(String(error)),
      state.latest ?? null
    )
  }

  /** The count to report: this close's, or a place an absorbed close could not deliver. */
  private takeSeen(state: PaneHostState, seenTimelineCount: number): number {
    const merged = Math.max(seenTimelineCount, state.pendingSeen)
    state.pendingSeen = 0
    return merged
  }

  private sendClose(args: {
    paneKey: string
    environmentId: string
    seenTimelineCount: number
  }): void {
    void this.deps.hostFold
      .close({
        paneKey: args.paneKey,
        environmentId: args.environmentId,
        seenTimelineCount: args.seenTimelineCount
      })
      .catch(() => {})
  }

  private clearTimer(paneKey: string): void {
    const timer = this.timers.get(paneKey)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(paneKey)
    }
  }
}
