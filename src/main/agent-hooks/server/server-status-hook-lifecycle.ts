import { drainAgentHookSpoolAsync, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { statusRowReceivedAt } from './server-ingest-normalization'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'
import { ClaudeAgentViewBridge } from '../../claude/agent-view-bridge'

/** How often a spooled post that never reached the listener is replayed while Orca runs. */
export const STATUS_SPOOL_DRAIN_INTERVAL_MS = 5_000

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerRuntimeEnv {
  readonly claudeAgentViews = new ClaudeAgentViewBridge()
  private statusHookInitialization: Promise<void> | null = null
  private statusSpoolDrainTimer: ReturnType<typeof setInterval> | null = null
  private statusSpoolDrainInFlight: Promise<void> | null = null

  setStatusHooksEnabled(enabled: boolean): void {
    if (enabled === this.statusHooksEnabled) {
      return
    }
    this.statusHookGeneration += 1
    if (!enabled) {
      this.stopStatusSpoolDrainLoop()
      this.claudeAgentViews.clear()
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      for (const timer of this.assistantMessageRetryTimers.values()) {
        clearTimeout(timer)
      }
      this.assistantMessageRetryTimers.clear()
      this.clearAllTranscriptPolls()
      this.clearScreenPromptReads()
    }
    this.statusHooksEnabled = enabled
    if (enabled && this.server) {
      void this.initializeStatusHookOwner().catch((error: unknown) => {
        console.error('[agent-hooks] status initialization failed', error)
      })
      this.startOpenCodeBinderLoop()
      this.startStatusSpoolDrainLoop()
    }
  }

  protected initializeStatusHookOwner(): Promise<void> {
    this.statusHookInitialization ??= this.loadStatusHookOwner().finally(() => {
      this.statusHookInitialization = null
    })
    // Why: publish this phase separately so snapshot readers can proceed as
    // soon as durable state is ready, without waiting for listener binding.
    this.statusCacheHydrationReady = this.statusHookInitialization
    return this.statusHookInitialization
  }

  private async loadStatusHookOwner(): Promise<void> {
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    if (!this.ownerStateInitialized) {
      // Hydrate before binding so the first live hook sees restored ownership.
      if (this.lastStatusFilePath) {
        this.hydrateLastStatusFromDisk()
      }
      this.captureHydratedAuthorityCommitments()
      // Drain before binding so replay cannot race live hooks.
      if (this.endpointDir) {
        const replayedPaneKeys = new Set<string>()
        await drainAgentHookSpoolAsync({
          endpointDir: this.endpointDir,
          getPersistedLaunchTokenHash: (paneKey) =>
            this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
          ingest: async (record: SpoolRecord) => {
            if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
              throw new Error('Status hook spool replay interrupted')
            }
            await this.ingestSpoolRecord(record)
            replayedPaneKeys.add(this.resolvePaneKeyAlias(record.paneKey))
          }
        })
        if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
          return
        }
        // Replayed owners may have died while Orca was down; probe each pane once.
        for (const paneKey of replayedPaneKeys) {
          void this.checkAgentPresence(paneKey)
        }
      }
      this.ownerStateInitialized = true
      this.adoptHydratedScreenPromptRows()
    }
    this.startStatusSpoolDrainLoop()
  }

  /**
   * Why a timer: the shell hook spools a post it could not deliver, and the spool used to be read
   * exactly once — before the listener bound — so a Stop lost to a brief main-process stall waited
   * for the next event or the next launch. A replay is safe to repeat: the launch-token check and the
   * replay disposition already refuse a stale record, and a torn line stays for the next tick.
   */
  protected startStatusSpoolDrainLoop(): void {
    if (this.statusSpoolDrainTimer !== null || !this.endpointDir || !this.ownerStateInitialized) {
      return
    }
    this.statusSpoolDrainTimer = setInterval(
      () => this.drainStatusHookSpool(),
      STATUS_SPOOL_DRAIN_INTERVAL_MS
    )
    this.statusSpoolDrainTimer.unref?.()
  }

  protected stopStatusSpoolDrainLoop(): void {
    if (this.statusSpoolDrainTimer !== null) {
      clearInterval(this.statusSpoolDrainTimer)
      this.statusSpoolDrainTimer = null
    }
  }

  private drainStatusHookSpool(): void {
    if (!this.endpointDir || !this.statusHooksEnabled) {
      return
    }
    // Why one drain at a time: a slow tick must not overlap the next one and ingest a record twice.
    this.statusSpoolDrainInFlight ??= this.drainStatusHookSpoolOnce().finally(() => {
      this.statusSpoolDrainInFlight = null
    })
  }

  private async drainStatusHookSpoolOnce(): Promise<void> {
    const endpointDir = this.endpointDir
    if (!endpointDir) {
      return
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    // Why captured here: applying a replay stamps its own row, so a drain of two records for one pane
    // would drop the second one. This is the state the drain started from, and within the drain each
    // per-pane file is already in write order.
    const rowStamps = this.captureStatusRowStamps()
    try {
      await drainAgentHookSpoolAsync({
        endpointDir,
        getPersistedLaunchTokenHash: (paneKey) =>
          this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
        ingest: async (record: SpoolRecord) => {
          if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
            throw new Error('Status hook spool replay interrupted')
          }
          // Why the marker and not the startup drain: only a drain that runs while hooks are live can
          // apply a record the pane has already moved past. It rides on the record the same way
          // `isReplay` does, so neither the ingest signature nor its callers change.
          await this.ingestSpoolRecord({
            ...record,
            requireNewerThanRow: true,
            replayRowReceivedAt:
              rowStamps.get(this.resolvePaneKeyAlias(record.paneKey)) ??
              rowStamps.get(record.paneKey)
          })
        }
      })
    } catch (error) {
      // Why quiet on an interruption: a toggle or restart re-runs the drain, and the file is intact.
      if (this.token === token && this.statusHookGeneration === statusHookGeneration) {
        console.warn('[agent-hooks] status hook spool drain failed', error)
      }
    }
  }

  /** Pane arrival stamps as they stood when the drain started, under both key spellings. */
  private captureStatusRowStamps(): Map<string, number> {
    const stamps = new Map<string, number>()
    for (const [paneKey, row] of this.state.lastStatusByPaneKey) {
      const stamp = statusRowReceivedAt(row)
      if (stamp === undefined) {
        continue
      }
      stamps.set(paneKey, stamp)
      stamps.set(this.resolvePaneKeyAlias(paneKey), stamp)
    }
    return stamps
  }
}
