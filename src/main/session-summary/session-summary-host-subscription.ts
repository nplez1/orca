// A fold that runs on the paired host owning the session, and the polling that keeps the
// pane current with it.
//
// Polling rather than a held-open call or a stream: a fold of a long session outlives a
// relay idle window, "still running? / what is the ledger now?" is all the pane needs, and
// a reconnecting client resumes against the same host state with no teardown to get wrong.
import type { SessionSummaryHostFoldClient } from './session-summary-host-fold-client'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'

const DEFAULT_POLL_INTERVAL_MS = 600
const MAX_POLL_RETRIES = 1

export type SessionSummaryHostSubscriptionDeps = {
  hostFold: SessionSummaryHostFoldClient
  pollIntervalMs?: number
  /** The host answered with a newer snapshot (first open, or a poll). */
  onSnapshot: (paneKey: string, snapshot: SessionSummarySnapshot) => void
  /** The open or a poll failed; `snapshot` is passed through when one was already shown. */
  onError: (paneKey: string, error: Error, snapshot: SessionSummarySnapshot | null) => void
}

export class SessionSummaryHostFoldSubscription {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-pane chain generation: an older chain stops instead of polling twice. */
  private readonly tokens = new Map<string, number>()
  private readonly latest = new Map<string, SessionSummarySnapshot>()
  private readonly pollFailures = new Map<string, number>()

  constructor(private readonly deps: SessionSummaryHostSubscriptionDeps) {}

  /** Starts (or restarts) a host fold for the pane. */
  open(args: {
    paneKey: string
    environmentId: string
    foldParams: ResolvedSourceControlAiGenerationParams | null
    lastSnapshot: SessionSummarySnapshot | null
  }): void {
    const token = this.bumpToken(args.paneKey)
    this.clearTimer(args.paneKey)
    void this.runOpen(args, token)
  }

  cancel(paneKey: string): void {
    this.bumpToken(paneKey)
    this.clearTimer(paneKey)
  }

  /** Forgets the pane entirely, telling the host what the viewer actually saw. */
  close(args: { paneKey: string; environmentId: string; seenTimelineCount: number }): void {
    this.cancel(args.paneKey)
    this.tokens.delete(args.paneKey)
    this.latest.delete(args.paneKey)
    this.pollFailures.delete(args.paneKey)
    void this.deps.hostFold.close(args).catch(() => {})
  }

  private async runOpen(
    args: {
      paneKey: string
      environmentId: string
      foldParams: ResolvedSourceControlAiGenerationParams | null
      lastSnapshot: SessionSummarySnapshot | null
    },
    token: number
  ): Promise<void> {
    try {
      const snapshot = await this.deps.hostFold.open({
        environmentId: args.environmentId,
        paneKey: args.paneKey,
        foldParams: args.foldParams
      })
      this.accept(args.paneKey, token, snapshot, args.environmentId)
    } catch (error) {
      this.fail(args.paneKey, token, error, args.lastSnapshot)
    }
  }

  private accept(
    paneKey: string,
    token: number,
    snapshot: SessionSummarySnapshot,
    environmentId: string
  ): void {
    if (this.tokens.get(paneKey) !== token) {
      return
    }
    this.latest.set(paneKey, snapshot)
    this.pollFailures.delete(paneKey)
    this.deps.onSnapshot(paneKey, snapshot)
    this.schedule(paneKey, token, environmentId)
  }

  private schedule(paneKey: string, token: number, environmentId: string): void {
    if (!this.latest.get(paneKey)?.fold.running) {
      return
    }
    this.clearTimer(paneKey)
    this.timers.set(
      paneKey,
      setTimeout(() => {
        this.timers.delete(paneKey)
        void this.poll(paneKey, token, environmentId)
      }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    )
  }

  private async poll(paneKey: string, token: number, environmentId: string): Promise<void> {
    if (this.tokens.get(paneKey) !== token) {
      return
    }
    try {
      const snapshot = await this.deps.hostFold.peek({ environmentId, paneKey })
      this.accept(paneKey, token, snapshot, environmentId)
    } catch (error) {
      // Why one retry: a relay blip must not freeze a stale brief under "Up to date".
      const failures = (this.pollFailures.get(paneKey) ?? 0) + 1
      if (failures <= MAX_POLL_RETRIES && this.tokens.get(paneKey) === token) {
        this.pollFailures.set(paneKey, failures)
        this.schedule(paneKey, token, environmentId)
        return
      }
      this.fail(paneKey, token, error, this.latest.get(paneKey) ?? null)
    }
  }

  private fail(
    paneKey: string,
    token: number,
    error: unknown,
    snapshot: SessionSummarySnapshot | null
  ): void {
    if (this.tokens.get(paneKey) !== token) {
      return
    }
    this.clearTimer(paneKey)
    this.deps.onError(paneKey, error instanceof Error ? error : new Error(String(error)), snapshot)
  }

  private bumpToken(paneKey: string): number {
    const token = (this.tokens.get(paneKey) ?? 0) + 1
    this.tokens.set(paneKey, token)
    return token
  }

  private clearTimer(paneKey: string): void {
    const timer = this.timers.get(paneKey)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(paneKey)
    }
  }
}
