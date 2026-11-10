#!/usr/bin/env node
/**
 * The release's review gate: a release may not be dispatched until the review of its resolution is
 * COMPLETE, and completeness is a manifest rather than a claim.
 *
 * Why this exists. On 2026-11-10 the 2026-11-10 sync shipped as `v1.4.214-np.49` after a review that
 * had spawned six slices and received findings from three. The reviewer returned "done", the summary
 * said "three slices completed", and nothing anywhere could tell a half-read resolution from a fully
 * read one — so the release was dispatched on a third of its review. Two of the six defects that
 * review did find were invisible to `pnpm tc` (one sat in a `@ts-nocheck` file), which is exactly the
 * class a review exists to catch and exactly the class a green test suite cannot.
 *
 * The fix is not diligence. `local/open-pr.mjs` already refuses a PR body without a review claim
 * line; the release had no equivalent, and `gh workflow run` accepted anything. So the dispatch path
 * is now `local/dispatch-release.mjs`, which refuses without a manifest that this file validates.
 *
 * What "complete" means, concretely: every slice the review planned has a verdict recorded, and no
 * slice carries an unresolved blocking finding. A slice that was dispatched and never reported is
 * recorded as `no-report` and FAILS — silence is the failure mode this gate was built for, so it may
 * not be represented by an absent field.
 *
 * Manifest: `local/sync/release-review/<revision>.json`, committed, so the review of a release is as
 * reviewable as the release itself.
 *
 *   node local/release-review-gate.mjs                    validate HEAD's manifest
 *   node local/release-review-gate.mjs --revision <sha>   validate another revision's
 *   node local/release-review-gate.mjs --print            print the manifest the gate expects
 *
 * Exit: 0 complete, 1 refuse, 2 usage.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWER } from './pr-body-claims.mjs'

const repoRoot = join(import.meta.dirname, '..')
const MANIFEST_DIR = 'local/sync/release-review'

/** A verdict a slice may carry and still let the release through. */
const REPORTED = 'reported'
/** A slice that was dispatched and never answered. Named so it can never be a missing field. */
const NO_REPORT = 'no-report'

export const manifestPath = (revision) => join(MANIFEST_DIR, `${revision}.json`)

function reviewerProblem(reviewer) {
  if (!reviewer || typeof reviewer !== 'object') {
    return `no reviewer recorded; the gate requires ${REVIEWER.name} at ${REVIEWER.thinking}`
  }
  const wrong = ['provider', 'alias', 'name', 'thinking'].filter(
    (key) => reviewer[key] !== REVIEWER[key]
  )
  return wrong.length
    ? `reviewer is ${JSON.stringify(reviewer)}, not ${JSON.stringify(REVIEWER)} (${wrong.join(', ')} differ)`
    : null
}

/**
 * Every reason this manifest does not clear the gate. Returned as a list rather than thrown one at a
 * time, because a reader who is told all four problems fixes them in one pass instead of four.
 */
export function validateManifest(manifest, { revision } = {}) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') {
    return ['no manifest: the review of this revision is not recorded']
  }
  if (revision && manifest.revision !== revision) {
    problems.push(
      `manifest is for ${String(manifest.revision).slice(0, 12)}, not the revision being released (${revision.slice(0, 12)})`
    )
  }
  const reviewer = reviewerProblem(manifest.reviewer)
  if (reviewer) {
    problems.push(reviewer)
  }

  const slices = Array.isArray(manifest.slices) ? manifest.slices : []
  if (!slices.length) {
    problems.push('no slices recorded: a review with no slice list cannot be shown to be complete')
  }
  const waived = manifest.waiver && String(manifest.waiver.reason ?? '').trim()
  for (const slice of slices) {
    const id = slice?.id ?? '(unnamed)'
    if (slice?.verdict === NO_REPORT) {
      // Why a hard problem and not a warning: this is the 2026-11-10 failure itself. Three slices
      // were dispatched, none answered, and the release went out on the other three.
      problems.push(`slice ${id} was dispatched and never reported (verdict "${NO_REPORT}")`)
    } else if (slice?.verdict !== REPORTED) {
      problems.push(
        `slice ${id} has no verdict recorded (got ${JSON.stringify(slice?.verdict ?? null)})`
      )
    }
    const unresolved = Number(slice?.unresolved ?? 0)
    if (Number.isFinite(unresolved) && unresolved > 0) {
      problems.push(`slice ${id} carries ${unresolved} unresolved blocking finding(s)`)
    }
  }
  if (waived) {
    // A waiver is allowed to clear the slice and unresolved problems, never the reviewer or revision:
    // those are facts about which review happened, and a waiver cannot make a review be a different
    // review. It is reported by the dispatcher and belongs in the release body.
    return problems.filter((problem) =>
      /^(manifest is for|no reviewer|reviewer is|no slices)/.test(problem)
    )
  }
  return problems
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function main(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--print') {
      args.set('print', true)
    } else if (argv[i].startsWith('--')) {
      args.set(argv[i].slice(2), argv[i + 1])
      i += 1
    }
  }
  let revision
  try {
    revision = args.get('revision') ?? git(['rev-parse', 'HEAD'])
  } catch {
    console.error('release-review-gate: not a git repository')
    return 2
  }

  const path = join(repoRoot, manifestPath(revision))
  if (args.get('print')) {
    console.log(
      JSON.stringify(
        {
          revision,
          base: '<the pre-sync fork tip>',
          upstream: '<the upstream commit merged in>',
          reviewer: REVIEWER,
          artifact: {
            kind: 'remerge-diff',
            path: '<git show --remerge-diff <merge> > file>',
            bytes: 0
          },
          slices: [
            {
              id: 'A',
              lines: '<start-end>',
              scope: '<what this slice covers>',
              verdict: REPORTED,
              blockers: 0,
              shouldFix: 0,
              minors: 0,
              nits: 0,
              unresolved: 0
            }
          ],
          waiver: null
        },
        null,
        2
      )
    )
    return 0
  }

  if (!existsSync(path)) {
    console.error(`release-review-gate: REFUSE — no review manifest for ${revision.slice(0, 12)}`)
    console.error(`  expected: ${manifestPath(revision)}`)
    console.error(
      `  scaffold one with: node local/release-review-gate.mjs --print > ${manifestPath(revision)}`
    )
    return 1
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(
      `release-review-gate: REFUSE — ${manifestPath(revision)} is not readable JSON: ${error.message}`
    )
    return 1
  }

  const problems = validateManifest(manifest, { revision })
  const slices = Array.isArray(manifest.slices) ? manifest.slices : []
  const reported = slices.filter((slice) => slice?.verdict === REPORTED).length
  if (problems.length) {
    console.error(
      `release-review-gate: REFUSE — the review of ${revision.slice(0, 12)} is not complete (${reported}/${slices.length} slices reported)`
    )
    for (const problem of problems) {
      console.error(`  - ${problem}`)
    }
    if (manifest.waiver?.reason) {
      console.error(`  waiver recorded: ${manifest.waiver.reason}`)
    }
    console.error(
      '  re-run the missing slices, or record a waiver with a reason before dispatching'
    )
    return 1
  }

  const waived = Boolean(manifest.waiver?.reason)
  console.log(
    `release-review-gate: PASS — ${reported}/${slices.length} slices reported, ${REVIEWER.name} at ${REVIEWER.thinking}, revision ${revision.slice(0, 12)}`
  )
  if (waived) {
    console.log(`  WAIVED: ${manifest.waiver.reason}`)
  }
  return 0
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
