/** Scheduled work a Pi session still has armed, as its own extension reports it.
 *
 *  `/loop` presents one surface over two backends — a live timer that re-enters the session, and a cold
 *  job in pi-subagents' scheduler that spawns a fresh subagent — so both arrive here as one inventory.
 *  Absence is not evidence of work: no inventory means no hold, which is what keeps an older build that
 *  serves neither channel reading exactly as it does today. */
export type PiScheduledJob = {
  id: string
  kind: 'live' | 'cold'
  /** Milliseconds until the next fire; absent while a self-paced loop has no armed wakeup. */
  nextInMs?: number
}

/** What a pane was last told is armed, and when that post arrived: the fire times are relative to it,
 *  so the hold ages from the receipt rather than from whenever the row is next republished. */
export type PiScheduledWorkInventory = {
  jobs: readonly PiScheduledJob[]
  receivedAt: number
}

/** The wire field is a claim on the row, so it is bounded rather than trusted. */
export const PI_SCHEDULED_WORK_MAX_JOBS = 20
/** A fire later than the extension's own 7-day loop TTL is a broken clock, not a schedule. */
const PI_SCHEDULED_WORK_MAX_NEXT_MS = 8 * 24 * 60 * 60 * 1000
/** A fire this far overdue means nothing refreshed the inventory, so the evidence is stale. */
const PI_SCHEDULED_WORK_LATE_MS = 2 * 60 * 1000
/** How long a cached inventory is believed at all. The extension restates a held row every 10 minutes
 *  and re-checks every minute (`agent-status-scheduled-work-source.ts`), and its key excludes the
 *  countdown, so a fire that merely moves posts nothing — the restatement is the only freshness
 *  signal there is, and an inventory this old came from an extension that stopped posting. */
const PI_SCHEDULED_WORK_MAX_AGE_MS = 10 * 60 * 1000 + 60 * 1000 + PI_SCHEDULED_WORK_LATE_MS

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether a fire is still due `elapsedMs` after the post that carried it. Past the grace nothing
 *  refreshed the inventory, so the evidence is stale and must hold nothing. A job that arms no fire
 *  time — a self-paced loop waiting for its next wakeup — is live on this test alone; the inventory's
 *  own age is what bounds it (`piScheduledWorkIsLive`). */
function piScheduledFireIsLive(nextInMs: number | undefined, elapsedMs = 0): boolean {
  return nextInMs === undefined || nextInMs - elapsedMs >= -PI_SCHEDULED_WORK_LATE_MS
}

/** Whether any of the inventory is still armed at `now`: a fire that is not long overdue, on an
 *  inventory the pane's extension is still restating. The age bounds every job shape, including the
 *  ones that carry no fire time to age against. */
export function piScheduledWorkIsLive(inventory: PiScheduledWorkInventory, now: number): boolean {
  const elapsedMs = now - inventory.receivedAt
  if (elapsedMs > PI_SCHEDULED_WORK_MAX_AGE_MS) {
    return false
  }
  return inventory.jobs.some((job) => piScheduledFireIsLive(job.nextInMs, elapsedMs))
}

function readJobs(value: unknown): PiScheduledJob[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const jobs: PiScheduledJob[] = []
  for (const entry of value.slice(0, PI_SCHEDULED_WORK_MAX_JOBS)) {
    if (!isRecord(entry)) {
      continue
    }
    const job = entry
    if (typeof job.id !== 'string' || !job.id) {
      continue
    }
    if (job.kind !== 'live' && job.kind !== 'cold') {
      continue
    }
    const nextInMs = job.next_in_ms
    if (nextInMs !== undefined && (typeof nextInMs !== 'number' || !Number.isFinite(nextInMs))) {
      continue
    }
    if (
      typeof nextInMs === 'number' &&
      (!piScheduledFireIsLive(nextInMs) || nextInMs > PI_SCHEDULED_WORK_MAX_NEXT_MS)
    ) {
      continue
    }
    jobs.push({ id: job.id, kind: job.kind, ...(typeof nextInMs === 'number' ? { nextInMs } : {}) })
  }
  return jobs
}

/** The scheduled work an event carries, or null when it carries none at all. */
export function readPiScheduledWork(hookPayload: Record<string, unknown>): PiScheduledJob[] | null {
  const field = hookPayload['scheduled_work']
  if (!isRecord(field)) {
    return null
  }
  return readJobs(field['jobs'])
}
