import { createOsc133CommandFinishedScanner } from '../../shared/terminal/output/terminal-osc133-command-finished'
import { createSetupCompletionScanner } from './orchestration/workers/launch/setup-completion-signal'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from './terminal/wait/terminal-wait-visible-probe'
import type { RuntimeClientEvent } from '../../shared/remote-runtime/session-graph/runtime-client-events'

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
  /** Undoes this runner's own end signals: its output subscription and its watchdog. */
  stop: () => void
}

type SetupRunnerEndPorts = {
  subscribeToTerminalData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  onEnd: () => void
}

/**
 * Watches a setup runner's own end signals: the marker its wrapper prints, then
 * OSC 133;D for a runner interrupted back to its prompt.
 *
 * Why not `waitForSetupTerminalCompletion`: that wait consumes the shared
 * completion token, and a structured launch waiting on the same setup would then
 * never see it end. This reads the token and never clears it.
 */
export function observeSetupRunnerEnd(
  ptyId: string,
  completionToken: string,
  ports: SetupRunnerEndPorts
): () => void {
  let ended = false
  const end = (): void => {
    if (ended) {
      return
    }
    ended = true
    ports.onEnd()
  }
  const scanCompletion = createSetupCompletionScanner(completionToken, end).scan
  const scanCommandFinished = createOsc133CommandFinishedScanner(end).scan
  const scanOutput = (data: string): void => {
    scanCommandFinished(data)
    scanCompletion(data)
  }
  const unsubscribe = ports.subscribeToTerminalData(ptyId, scanOutput)
  // Why replay: a fast setup prints its marker before the observer is attached.
  const replay = ports.readRecentOutput(ptyId)
  if (replay) {
    scanOutput(replay)
  }
  return unsubscribe
}

/**
 * Which worktrees are setting up, and which PTYs said so.
 *
 * Kept apart from the runtime so the rules that matter are testable: one
 * announcement per worktree however many runners it has, and the first end
 * signal for a PTY wins.
 */
export class SetupRunnerAnnouncements {
  private readonly observationByPtyId = new Map<string, SetupRunnerObservation>()
  private readonly ptyCountByWorktreeId = new Map<string, number>()
  private readonly runningWorktreeIds = new Set<string>()
  private readonly announce: (worktreeId: string, running: boolean) => void

  constructor(announce: (worktreeId: string, running: boolean) => void) {
    this.announce = announce
  }

  /** A PTY is already watched: a second arm would double-count its worktree. */
  isObserving(ptyId: string): boolean {
    return this.observationByPtyId.has(ptyId)
  }

  runningWorktreeIdsSnapshot(): string[] {
    return [...this.runningWorktreeIds].sort()
  }

  start(ptyId: string, worktreeId: string, stop: () => void): void {
    this.observationByPtyId.set(ptyId, { worktreeId, stop })
    const count = (this.ptyCountByWorktreeId.get(worktreeId) ?? 0) + 1
    this.ptyCountByWorktreeId.set(worktreeId, count)
    // Why: only the first runner announces; a second one for the same worktree
    // must not be un-announced when the first ends.
    if (count === 1) {
      this.setRunning(worktreeId, true)
    }
  }

  /** Idempotent: the first end signal for a PTY wins and later ones do nothing. */
  end(ptyId: string): void {
    const observation = this.observationByPtyId.get(ptyId)
    if (!observation) {
      return
    }
    this.observationByPtyId.delete(ptyId)
    observation.stop()
    const count = this.ptyCountByWorktreeId.get(observation.worktreeId) ?? 0
    if (count > 1) {
      this.ptyCountByWorktreeId.set(observation.worktreeId, count - 1)
      return
    }
    this.ptyCountByWorktreeId.delete(observation.worktreeId)
    this.setRunning(observation.worktreeId, false)
  }

  private setRunning(worktreeId: string, running: boolean): void {
    if (running === this.runningWorktreeIds.has(worktreeId)) {
      return
    }
    if (running) {
      this.runningWorktreeIds.add(worktreeId)
    } else {
      this.runningWorktreeIds.delete(worktreeId)
    }
    this.announce(worktreeId, running)
  }
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
export abstract class OrcaRuntimeWithSetupRunnerState extends OrcaRuntimeWithStartTuiIdleVisibleReadProbe {
  private readonly setupRunnerAnnouncements = new SetupRunnerAnnouncements((worktreeId, running) =>
    this.notifyWorktreeSetupRunnerState(worktreeId, running)
  )

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
    if (!ptyId || this.setupRunnerAnnouncements.isObserving(ptyId)) {
      return
    }
    // Why the runtime records it: a caller that waits for structured setup later
    // reads the token from here, and arming must not be the only owner of it.
    this.setupCompletionTokenByPtyId.set(ptyId, completionToken)
    const watchdog = setTimeout(() => {
      console.warn(
        `[runtime] setup runner for ${worktreeId} never reported an end; clearing its setting-up state`
      )
      this.endWorktreeSetupRunner(ptyId)
    }, SETUP_RUNNER_WATCHDOG_MS)
    // Why: a pending hour-long timer must not hold the process open.
    watchdog.unref?.()
    let unsubscribe: () => void = () => {}
    // Why announce before observing: replayed output below can end the runner
    // synchronously, and an end before the start would announce nothing.
    this.setupRunnerAnnouncements.start(ptyId, worktreeId, () => {
      unsubscribe()
      clearTimeout(watchdog)
    })
    unsubscribe = observeSetupRunnerEnd(ptyId, completionToken, {
      subscribeToTerminalData: (id, listener) => this.subscribeToTerminalData(id, listener),
      readRecentOutput: (id) => this.recentPtyOutputById.get(id)?.read(),
      onEnd: () => this.endWorktreeSetupRunner(ptyId)
    })
  }

  notifyWorktreeSetupRunnerState(worktreeId: string, running: boolean): void {
    this.emitClientEvent({ type: 'worktreeSetupRunnerState', worktreeId, running })
  }

  /**
   * Replayed to a client on subscribe so a renderer reload, or a reconnect after
   * a dropped completion, cannot leave a worktree stuck on "Setting up". The host
   * clears its own set on completion regardless of who is listening, so this is
   * always the current truth.
   */
  getSetupRunnerClientEventSnapshot(): RuntimeClientEvent[] {
    return this.setupRunnerAnnouncements.runningWorktreeIdsSnapshot().map((worktreeId) => ({
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
    this.setupRunnerAnnouncements.end(ptyId)
  }
}
