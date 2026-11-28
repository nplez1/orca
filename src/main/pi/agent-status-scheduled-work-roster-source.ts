import type { PiAgentKind } from '../../shared/agent-launch/catalog/pi-agent-kind'

/** The reader half of the scheduled-work lane: what each home's list answer actually claims.
 *
 *  `/loop` and pi-subagents present one roster with two homes, and both list jobs that cannot fire — a
 *  paused loop keeps its id and cadence, a spent cold job keeps its last slot — so the answer is parsed
 *  here rather than trusted. Emitted beside `getPiAgentStatusScheduledWorkModuleLines`, whose budget it
 *  would otherwise break: this is the one piece of that module holding no state. */
export function getPiAgentStatusScheduledWorkRosterLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '// Why structural and total: a newer scheduler adding a field must not break the footer, and a job',
    '// that cannot fire again holds nothing — listed is not the same claim as armed.',
    'function piScheduledWorkReadJobs(raw: unknown, kind: "live" | "cold"): PiScheduledWorkJob[] {',
    '  const jobs: PiScheduledWorkJob[] = []',
    '  const list = (raw as { jobs?: unknown } | null | undefined)?.jobs',
    '  if (!Array.isArray(list)) return jobs',
    '  const now = Date.now()',
    '  for (const entry of list.slice(0, PI_SCHEDULED_WORK_MAX_JOBS)) {',
    "    if (!entry || typeof entry !== 'object') continue",
    '    const job = entry as {',
    '      id?: unknown',
    '      enabled?: unknown',
    '      paused?: unknown',
    '      runs?: unknown',
    '      runCount?: unknown',
    '      maxRuns?: unknown',
    '      until?: unknown',
    '      nextAt?: unknown',
    '      nextRun?: unknown',
    '    }',
    "    if (typeof job.id !== 'string' || !job.id) continue",
    '    // Why both homes: pausing keeps the id, prompt and cadence and arms nothing, so a paused job is still',
    '    // listed — live says `paused`, the scheduler `enabled: false`. Listed is not armed: it claims no hold.',
    '    if (job.paused === true || job.enabled === false) continue',
    '    const nextAt =',
    "      typeof job.nextAt === 'number' && Number.isFinite(job.nextAt)",
    '        ? job.nextAt',
    "        : typeof job.nextRun === 'string'",
    '          ? Date.parse(job.nextRun)',
    '          : Number.NaN',
    '    // Why the cold home alone: `runCount`, `enabled` and `nextRun` are written together at finalize, so a',
    '    // firing cold job still reads its pre-fire count and the slot that fired. `/loop` moves `runs` when it',
    "    // arms the fire, before that fire's turn starts — the same test would release a live pane mid-fire.",
    '    if (kind === "cold") {',
    '      const runs =',
    "        typeof job.runs === 'number' ? job.runs : typeof job.runCount === 'number' ? job.runCount : 0",
    "      if (typeof job.maxRuns === 'number' && job.maxRuns > 0 && runs >= job.maxRuns) continue",
    '      const until =',
    "        typeof job.until === 'number'",
    '          ? job.until',
    "          : typeof job.until === 'string'",
    '            ? Date.parse(job.until)',
    '            : Number.NaN',
    '      // Why both: the scheduler refuses a fire at or after `until`, and the armed fire is the last chance.',
    '      if (Number.isFinite(until) && (until <= now || (Number.isFinite(nextAt) && nextAt >= until))) continue',
    '    }',
    '    jobs.push({ id: job.id, kind, ...(Number.isFinite(nextAt) ? { nextAt } : {}) })',
    '  }',
    '  return jobs',
    '}',
    ''
  ]
}
