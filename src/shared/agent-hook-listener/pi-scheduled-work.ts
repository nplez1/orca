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

/** The wire field is a claim on the row, so it is bounded rather than trusted. */
export const PI_SCHEDULED_WORK_MAX_JOBS = 20
/** A fire later than the extension's own 7-day loop TTL is a broken clock, not a schedule. */
const PI_SCHEDULED_WORK_MAX_NEXT_MS = 8 * 24 * 60 * 60 * 1000
/** A fire this far overdue means nothing refreshed the inventory, so the evidence is stale. */
const PI_SCHEDULED_WORK_LATE_MS = 2 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
    // Why: a fire still due, or due within the grace the extension's own timer allows, is live work; one
    // long overdue means nothing refreshed the inventory, and a hold must not outlive its evidence.
    if (
      typeof nextInMs === 'number' &&
      (nextInMs < -PI_SCHEDULED_WORK_LATE_MS || nextInMs > PI_SCHEDULED_WORK_MAX_NEXT_MS)
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
