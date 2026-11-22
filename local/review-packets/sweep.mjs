// The fine sweep: the same remerge diff cut small enough that one reviewer reads a file and its callers.
//
// Why this exists, measured on the 2026-11-20 sync (blind re-run, 2026-11-21). The nine consolidated
// Opus slices found 3 of the 10 blocking defects the 435-slice review had found; the same diff at fine
// granularity on a cheap model found 4 of 4 of the ones consolidation dropped, for $0.048 on four
// slices. Granularity decides what is FOUND; the model decides how well it is JUDGED. So the sweep
// finds — cheaply, over everything, because a fine slice costs $0.012 on the cheap tier — and
// `adjudicate.mjs` puts REVIEWER's judgment on every finding it raises.
//
// The one thing this file must never do is let a silent slice look finished: a slice with no recorded
// answer reads as `no-report`, by name, exactly like a CLI run that never answered.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSync } from './packet.mjs'
import { parseVerdict } from './verdict.mjs'

/**
 * Why 24 KB: the slices that caught the run-target clone bug were 5–15 KB of patch — one file with its
 * conflict hunks — while the 380 KB slice that contained the same code judged it correct. 24 KB keeps a
 * slice at one or two files and still batches path neighbours, which is what the wall clock needs.
 */
export const SWEEP_BUDGET_KB = 24
export const sweepReportName = (id) => `sweep-${id}.json`

/** The sweep lives inside the sync packet, so the review's two tiers travel together. */
export const sweepDirOf = (syncDir) => join(syncDir, 'sweep')

export function prepareSweep({ root, syncDir, merge, budgetBytes, context }) {
  return prepareSync({
    root,
    merge,
    budgetBytes: budgetBytes ?? SWEEP_BUDGET_KB * 1024,
    context,
    kind: 'sweep',
    dir: sweepDirOf(syncDir)
  })
}

/**
 * One slice's state from what the orchestrator recorded.
 *
 * Why the answer is re-parsed here instead of trusted: the cheap tier's reply comes back to an agent as
 * text, and an answer whose verdict block is missing or malformed is the failure this whole gate exists
 * for. `parseVerdict` is the same validator the CLI path uses, so both tiers are held to one contract.
 */
export function readSweepReport(dir, id) {
  const path = join(dir, sweepReportName(id))
  if (!existsSync(path)) {
    return { status: 'not-run', problem: 'no answer recorded' }
  }
  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { status: 'no-report', problem: `the record is not JSON: ${error.message}` }
  }
  const parsed = parseVerdict(record.answer)
  if (!parsed.ok) {
    return { status: 'no-report', problem: parsed.problem, reviewer: record.reviewer ?? null }
  }
  return {
    status: 'reported',
    verdict: parsed.verdict,
    counts: parsed.counts,
    warning: parsed.warning,
    reviewer: record.reviewer ?? null,
    cost: typeof record.costUsd === 'number' ? record.costUsd : null
  }
}

/**
 * Records the sweep's answers, one file per slice. Refuses an answer for a slice the packet does not
 * plan (a typo would otherwise record a verdict nothing ever reads and leave the real slice silent) and
 * refuses a duplicate, because the second answer is the one a reader would not expect to win.
 */
export function recordSweep({ dir, packet, answers, reviewer }) {
  const planned = new Map(packet.slices.map((slice) => [slice.id, slice]))
  const problems = []
  const seen = new Set()
  for (const answer of answers) {
    const id = String(answer?.id ?? '')
    if (!planned.has(id)) {
      problems.push(`no slice ${JSON.stringify(id)} in this packet`)
      continue
    }
    if (seen.has(id)) {
      problems.push(`slice ${id} was answered twice`)
      continue
    }
    seen.add(id)
    writeFileSync(
      join(dir, sweepReportName(id)),
      `${JSON.stringify({ slice: id, reviewer, answer: String(answer.answer ?? ''), costUsd: answer.costUsd ?? null }, null, 2)}\n`
    )
  }
  return { recorded: [...seen], problems }
}

/** Every sweep slice's state, and how many the sweep still owes an answer for. */
export function sweepState(dir, packet) {
  const slices = packet.slices.map((slice) => ({ slice, report: readSweepReport(dir, slice.id) }))
  const missing = slices
    .filter((entry) => entry.report.status !== 'reported')
    .map((entry) => entry.slice.id)
  return { dir, packet, slices, missing }
}
