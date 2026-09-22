import { createOsc133CommandFinishedScanner } from '../../shared/terminal-osc133-command-finished'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from './orca-runtime-start-tui-idle-visible-read-probe'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

/**
 * Hard ceiling for the "setting up" announcement.
 *
 * Why it exists: the runner can wedge without ever reporting an end — a shell
 * stuck in its own rc never executes the queued setup command, so no OSC 133 and
 * no completion marker ever arrive while the PTY stays alive. That is the one
 * shape the event-driven clears cannot see, so a timer breaks it. It is set far
 * above any real setup (a cold install across a large monorepo is minutes, not
 * hours) so a false clear is unlikely, and a false clear only restores the plain
 * 'active' dot this state replaces.
 */
export const SETUP_RUNNER_WATCHDOG_MS = 60 * 60 * 1000

type SetupRunnerObservation = {
  worktreeId: string
  /** OSC 133;D on the setup PTY: the command returned to its prompt. */
  unsubscribeCommandFinished: () => void
  watchdog: ReturnType<typeof setTimeout>
}

/**
 * Announces "this worktree's repo setup script is still running" to clients.
 *
 * Why the runtime owns it: the setup runner is a shell script, so nothing in the
 * agent hooks can report it, and the setup terminal is spawned by main — the
 * renderer never sees the runner. The host that spawned it is the only party
 * that can observe the start.
 *
 * Every clear is host-observed and independent, because a stuck "Setting up"
 * dot is worse than a missing one:
 *  - the completion marker (shell-agnostic, so `cmd.exe` is covered);
 *  - OSC 133;D (an interrupted runner returns to its prompt without the wrapper
 *    ever printing its marker — Ctrl+C is the case this exists for);
 *  - PTY exit, via `reapWorktreeSetupRunnerState` from the PTY reaper;
 *  - the watchdog above, for a runner that never starts at all.
 * The state is in-memory only, so a main-process restart cannot carry it over.
 */
export class OrcaRuntimeWithSetupRunnerState extends OrcaRuntimeWithStartTuiIdleVisibleReadProbe {
  private setupRunnerObservationByPtyId = new Map<string, SetupRunnerObservation>()
  private setupRunnerPtyCountByWorktreeId = new Map<string, number>()
  private setupRunnerRunningWorktreeIds = new Set<string>()

  /**
   * Marks `worktreeId` as setting up until its setup runner ends.
   *
   * `completionToken` must match the token the setup command was wrapped with
   * (`buildObservedSetupCommand`); without it there is no shell-agnostic end
   * signal for a shell that emits no OSC 133 (cmd.exe), so callers on such paths
   * must not arm at all rather than risk a dot stuck on "Setting up".
   */
  armWorktreeSetupRunner(handle: string, worktreeId: string, completionToken: string): void {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    // Why: a setup that already exited has nothing to observe, and announcing
    // 'running' now would strand the dot.
    if (!ptyId || this.setupRunnerObservationByPtyId.has(ptyId)) {
      return
    }
    this.setupCompletionTokenByPtyId.set(ptyId, completionToken)
    const unsubscribeCommandFinished = this.subscribeToTerminalData(
      ptyId,
      createOsc133CommandFinishedScanner(() => this.endWorktreeSetupRunner(ptyId)).scan
    )
    const watchdog = setTimeout(() => {
      console.warn(
        `[runtime] setup runner for ${worktreeId} never reported an end; clearing its setting-up state`
      )
      this.endWorktreeSetupRunner(ptyId)
    }, SETUP_RUNNER_WATCHDOG_MS)
    // Why: a pending hour-long timer must not hold the process open.
    watchdog.unref?.()
    this.setupRunnerObservationByPtyId.set(ptyId, {
      worktreeId,
      unsubscribeCommandFinished,
      watchdog
    })
    this.retainWorktreeSetupRunner(worktreeId)
    // Why: never rejects outward — the rejection path must clear the dot too.
    void this.waitForSetupTerminalCompletion(handle).then(
      () => this.endWorktreeSetupRunner(ptyId),
      () => this.endWorktreeSetupRunner(ptyId)
    )
  }

  notifyWorktreeSetupRunnerState(worktreeId: string, running: boolean): void {
    const wasRunning = this.setupRunnerRunningWorktreeIds.has(worktreeId)
    if (running === wasRunning) {
      return
    }
    if (running) {
      this.setupRunnerRunningWorktreeIds.add(worktreeId)
    } else {
      this.setupRunnerRunningWorktreeIds.delete(worktreeId)
    }
    this.emitClientEvent({ type: 'worktreeSetupRunnerState', worktreeId, running })
  }

  /**
   * Replayed to a client on subscribe so a renderer reload, or a reconnect after
   * a dropped completion, cannot leave a worktree stuck on "Setting up". The host
   * clears its own set on completion regardless of who is listening, so this is
   * always the current truth.
   */
  getSetupRunnerClientEventSnapshot(): RuntimeClientEvent[] {
    return [...this.setupRunnerRunningWorktreeIds].sort().map((worktreeId) => ({
      type: 'worktreeSetupRunnerState',
      worktreeId,
      running: true
    }))
  }

  /** Called by the PTY reaper: the PTY is gone, so nothing is setting up on it. */
  protected reapWorktreeSetupRunnerState(ptyId: string): void {
    this.endWorktreeSetupRunner(ptyId)
  }

  private endWorktreeSetupRunner(ptyId: string): void {
    const observation = this.setupRunnerObservationByPtyId.get(ptyId)
    if (!observation) {
      return
    }
    this.setupRunnerObservationByPtyId.delete(ptyId)
    clearTimeout(observation.watchdog)
    observation.unsubscribeCommandFinished()
    this.releaseWorktreeSetupRunner(observation.worktreeId)
  }

  private retainWorktreeSetupRunner(worktreeId: string): void {
    const count = (this.setupRunnerPtyCountByWorktreeId.get(worktreeId) ?? 0) + 1
    this.setupRunnerPtyCountByWorktreeId.set(worktreeId, count)
    // Why: only the first runner announces; a second one for the same worktree
    // must not be un-announced when the first ends.
    if (count === 1) {
      this.notifyWorktreeSetupRunnerState(worktreeId, true)
    }
  }

  private releaseWorktreeSetupRunner(worktreeId: string): void {
    const count = this.setupRunnerPtyCountByWorktreeId.get(worktreeId) ?? 0
    if (count > 1) {
      this.setupRunnerPtyCountByWorktreeId.set(worktreeId, count - 1)
      return
    }
    this.setupRunnerPtyCountByWorktreeId.delete(worktreeId)
    this.notifyWorktreeSetupRunnerState(worktreeId, false)
  }
}
