import { syncHostMesh } from './host-mesh-runtime'

/**
 * The mesh keeps itself current, so no surface needs a Sync button.
 *
 * Why a self-scheduling timer and not an interval: a fixed cadence is what the recurring-timer ratchet exists to
 * refuse — it keeps asking at full rate whether anything changed or not. This one is event-driven first (startup,
 * a connection appearing, an owner action, a peer joining) and falls back to a single reconcile that doubles its
 * wait on failure, so a fleet whose members are asleep costs almost nothing and a fleet that works is confirmed
 * about once a minute.
 *
 * Why in the main process and not in the pane: the mesh has to converge on a machine whose Settings nobody has
 * opened — that is the whole complaint it answers. The pane only ever reads the state this keeps.
 */

/** About once a minute while everything is reachable: one call per member, nothing dialled twice. */
const BASE_DELAY_MS = 60_000
/** A fleet that cannot be reached is retried less and less, not more and more. */
const MAX_DELAY_MS = 15 * 60_000
/** Long enough for pairing and the first connection to settle, short enough to look automatic. */
const STARTUP_DELAY_MS = 10_000
/** A nudge is a burst of the same event (three connections coming up), so it collapses into one pass. */
const NUDGE_DELAY_MS = 1_500

export type HostMeshAutoSyncOptions = {
  /** First pass delay, so a caller can make a startup pass observable in a test. */
  startupDelayMs?: number
  /** The pass itself; defaults to the real one, and a test supplies its own to avoid a peer and a clock. */
  run?: () => Promise<HostMeshAutoSyncOutcome>
}

/**
 * What a pass reports about itself.
 *
 * Why `reached` is needed: the driver catches every member failure per member, so a pass against a sleeping fleet
 * returns happily. A backoff keyed on a thrown error would therefore never engage, and the loop would dial the same
 * unreachable machines every minute for as long as the app runs.
 */
export type HostMeshAutoSyncOutcome = { reached: number; members: number } | undefined

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = true
let delay = BASE_DELAY_MS
let inFlight = false
let nudgedDuringPass = false
let runPass: () => Promise<HostMeshAutoSyncOutcome> = async () => {
  const snapshot = await syncHostMesh()
  return { reached: snapshot.lastPassReached ?? 0, members: snapshot.members.length }
}
let startupDelayMs = STARTUP_DELAY_MS

function schedule(ms: number): void {
  if (stopped) {
    return
  }
  if (timer !== null) {
    clearTimeout(timer)
  }
  timer = setTimeout(() => {
    timer = null
    void tick()
  }, ms)
  // Why unref: a background reconcile must never be the reason the app stays alive.
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (inFlight) {
    return
  }
  inFlight = true
  let reachedNobody = false
  try {
    const outcome = await runPass()
    reachedNobody = outcome !== undefined && outcome.members > 0 && outcome.reached === 0
    delay = reachedNobody ? Math.min(delay * 2, MAX_DELAY_MS) : BASE_DELAY_MS
  } catch {
    // Why the same treatment as a pass that reached nobody: an unreachable member is the normal state of a laptop
    // whose lid is closed, and a fleet that cannot answer must get quieter rather than louder.
    reachedNobody = true
    delay = Math.min(delay * 2, MAX_DELAY_MS)
  } finally {
    inFlight = false
  }
  // Why the nudge wins over the schedule: it arrived while a pass was running, so it is the newer information. A
  // dropped nudge is a machine that stays one-way until the next full interval.
  if (nudgedDuringPass && !reachedNobody) {
    nudgedDuringPass = false
    schedule(NUDGE_DELAY_MS)
    return
  }
  nudgedDuringPass = false
  schedule(delay)
}

/** Idempotent: a second call only replaces the first pass's timing, never adds a second chain. */
export function startHostMeshAutoSync(options: HostMeshAutoSyncOptions = {}): void {
  if (!stopped) {
    return
  }
  runPass =
    options.run ??
    (async () => {
      const snapshot = await syncHostMesh()
      return { reached: snapshot.lastPassReached ?? 0, members: snapshot.members.length }
    })
  startupDelayMs = options.startupDelayMs ?? STARTUP_DELAY_MS
  stopped = false
  delay = BASE_DELAY_MS
  nudgedDuringPass = false
  schedule(startupDelayMs)
}

/** Something changed that a pass would learn from: a connection, an owner action, a peer joining. */
export function nudgeHostMeshSync(): void {
  if (stopped) {
    return
  }
  if (inFlight) {
    nudgedDuringPass = true
    return
  }
  delay = BASE_DELAY_MS
  schedule(NUDGE_DELAY_MS)
}

export function stopHostMeshAutoSync(): void {
  stopped = true
  nudgedDuringPass = false
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}
