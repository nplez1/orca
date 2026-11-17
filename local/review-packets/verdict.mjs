// Reading a slice's output back: did the reviewer report, and what did it find.
//
// Why so strict about "reported": the release gate exists because a review returned "done" with
// half its slices silent. A slice counts as reported only when the CLI exited 0, its JSON result is
// not an error, and the answer ends with a parseable verdict block. Anything else is `no-report`,
// which the gate refuses — never a slice that quietly looks finished.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SEVERITIES = ['BLOCKER', 'SHOULD-FIX', 'MINOR', 'NIT']
/** The severities AGENTS.md § PR gate 2 says must be fixed before the release. */
export const BLOCKING = new Set(['BLOCKER', 'SHOULD-FIX'])
export const VERDICT_FENCE = 'orca-review-verdict'

const COUNT_KEYS = { BLOCKER: 'blockers', 'SHOULD-FIX': 'shouldFix', MINOR: 'minors', NIT: 'nits' }

/** The last verdict block in an answer, validated. `{ ok: false, problem }` when there is none. */
export function parseVerdict(answer) {
  const blocks = [
    ...String(answer ?? '').matchAll(
      new RegExp(`\`\`\`${VERDICT_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, 'g')
    )
  ]
  if (!blocks.length) {
    return { ok: false, problem: `the answer has no \`\`\`${VERDICT_FENCE} block` }
  }
  let verdict
  try {
    verdict = JSON.parse(blocks.at(-1)[1])
  } catch (error) {
    return { ok: false, problem: `the verdict block is not JSON: ${error.message}` }
  }
  if (!verdict || !Array.isArray(verdict.findings)) {
    return { ok: false, problem: 'the verdict block has no findings list' }
  }
  const bad = verdict.findings.find((finding) => !SEVERITIES.includes(finding?.severity))
  if (bad) {
    return { ok: false, problem: `a finding has severity ${JSON.stringify(bad?.severity)}` }
  }
  // Why the list decides and the counts only warn: the counts are the reviewer's summary of the list,
  // and a slip in the summary is not a reason to spend another slice run.
  const counts = Object.fromEntries(Object.values(COUNT_KEYS).map((key) => [key, 0]))
  for (const finding of verdict.findings) {
    counts[COUNT_KEYS[finding.severity]] += 1
  }
  const drift = Object.entries(counts).filter(
    ([key, value]) => verdict[key] !== undefined && Number(verdict[key]) !== value
  )
  return {
    ok: true,
    verdict,
    counts,
    warning: drift.length
      ? `the declared counts disagree with the findings list (${drift.map(([key, value]) => `${key}: said ${verdict[key]}, listed ${value}`).join('; ')})`
      : null
  }
}

export const outputPaths = (dir, id) => ({
  prompt: join(dir, `prompt-${id}.txt`),
  out: join(dir, `out-${id}.json`),
  err: join(dir, `err-${id}.log`),
  run: join(dir, `run-${id}.json`)
})

/** The state of one slice from its files on disk. */
export function readReport(dir, id) {
  const paths = outputPaths(dir, id)
  if (!existsSync(paths.run)) {
    return { status: 'not-run', problem: 'never run' }
  }
  const run = JSON.parse(readFileSync(paths.run, 'utf8'))
  if (run.exitCode !== 0) {
    const detail = run.error ?? (run.timedOut ? 'timed out' : `signal ${run.signal ?? 'none'}`)
    return { status: 'no-report', problem: `the CLI exited ${run.exitCode} (${detail})`, run }
  }
  let result
  try {
    result = JSON.parse(readFileSync(paths.out, 'utf8'))
  } catch (error) {
    return { status: 'no-report', problem: `the CLI output is not JSON: ${error.message}`, run }
  }
  const cost = Number(result.total_cost_usd ?? 0)
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    return {
      status: 'no-report',
      problem: `the CLI reported an error (${result.subtype ?? 'is_error'})`,
      cost,
      run
    }
  }
  const parsed = parseVerdict(result.result)
  if (!parsed.ok) {
    return { status: 'no-report', problem: parsed.problem, cost, run }
  }
  return {
    status: 'reported',
    verdict: parsed.verdict,
    counts: parsed.counts,
    warning: parsed.warning,
    cost,
    run
  }
}
