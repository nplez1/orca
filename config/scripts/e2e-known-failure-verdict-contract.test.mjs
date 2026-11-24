import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * This fork records the scheduled E2E failures it inherits from upstream, and lets the verdict step
 * decide the run's result so those stop failing it. The wiring is what keeps that from becoming
 * "the fork ignores E2E": it must stay out of upstream's runs, out of the PR lane, and off
 * Playwright's own exit code for a failure nobody recorded.
 *
 * Why no `${{ matrix.shard_name }}` in the step names below: upstream's un-sharded rewrite (in the
 * 2026-11-24 sync) replaced the matrix fan-out with one complete `e2e` job, so the two steps are
 * named plainly and the report lives at `e2e-results/results.json` rather than a per-shard
 * `ci-shards/` path. The fork's wiring survived that rewrite unchanged — same step ids, same
 * `continue-on-error`, same verdict command — and `--selected` is gone with the shard, since one
 * lane running the whole suite has no selection to prove the report against.
 */
const projectDir = resolve(import.meta.dirname, '../..')
const workflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
const manifest = JSON.parse(
  readFileSync(join(projectDir, 'local/e2e-known-failure-titles.json'), 'utf8')
)
const step = (name) => workflow.jobs.e2e.steps.find((candidate) => candidate.name === name)

describe('known-failure verdict wiring', () => {
  it('keeps Playwright in charge upstream and hands a fork run to the verdict', () => {
    const run = step('Run E2E tests')
    expect(run['continue-on-error']).toBe("${{ github.repository != 'stablyai/orca' }}")
    // Why this exact arrangement: Playwright honours PLAYWRIGHT_JSON_OUTPUT_FILE over
    // PLAYWRIGHT_JSON_OUTPUT_NAME when both are set, so naming a second file would leave the
    // verdict reading a report nothing writes. The step keeps upstream's own reporter argument and
    // its own env var, and the fork only reads the file they produce.
    expect(run.env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe('e2e-results/results.json')
    expect(run.run).toContain('--reporter=list,json')
    expect(run.run).not.toContain('PLAYWRIGHT_JSON_OUTPUT_NAME')
  })

  it('reads the report rather than the test step’s conclusion', () => {
    const verdict = step('Verdict on known failures')
    expect(verdict.if).toBe(
      "${{ github.repository != 'stablyai/orca' && steps.run-e2e.outcome != 'skipped' }}"
    )
    // Why the outcome argument: the verdict reads the report, and a report alone cannot tell an empty
    // run or a Playwright exit with no spec behind it apart from a green one (#210 G7).
    // Why no `--selected`: this lane runs the whole suite, so there is no shard selection to prove the
    // report against — the selection check stays on the caller lanes that hand this workflow a list.
    expect(verdict.run).toBe(
      'node local/check-e2e-known-failure-titles.mjs e2e-results/results.json local/e2e-known-failure-titles.json ${{ steps.run-e2e.outcome }}'
    )
    // The one report both the verdict and upstream's failure summary read.
    const summary = step('Summarize E2E failures')
    expect(summary.run).toBe(
      'node config/scripts/ci/e2e-failures/ci-e2e-failure-summary.mjs e2e-results/results.json'
    )
    const traces = step('Upload Playwright traces')
    // Why `|| cancelled()`: upstream's "retain cancellation traces" change (#24617) is kept beside the fork's outcome check.
    expect(traces.if).toBe("steps.run-e2e.outcome == 'failure' || cancelled()")
  })

  it('leaves the PR lane failing on any spec it runs', () => {
    const changedSteps = workflow.jobs['changed-e2e'].steps
    expect(changedSteps.some((candidate) => candidate.name?.startsWith('Verdict on known'))).toBe(
      false
    )
    const run = changedSteps.find((candidate) => candidate.name === 'Run changed E2E specs')
    expect(run['continue-on-error']).toBeUndefined()
  })

  it('records every entry with the fields the verdict reads', () => {
    // Why an empty list is allowed and why it must be recorded: the 2026-11-24 sync took upstream
    // #46786, which deleted every spec this manifest had recorded, so the inherited quarantine is now
    // empty by decision. A silently emptied list is still caught — an empty `titles` has to say why
    // it is empty in its own note.
    if (manifest.titles.length === 0) {
      expect(manifest.note.join(' ')).toContain('#46786')
      return
    }
    for (const entry of manifest.titles) {
      // Why nested: this tree groups e2e specs by area (`tests/e2e/terminal/rendering/…`).
      expect(entry.file).toMatch(/^tests\/e2e\/(?:[^/]+\/)*[^/]+\.spec\.ts$/)
      expect(entry.title.length).toBeGreaterThan(0)
      // Why: `*` is the file-level form in the unit manifests, and a title of `*` would turn one spec
      // entry into a whole-file one.
      expect(entry.title).not.toBe('*')
      expect(['upstream', 'unattributed']).toContain(entry.owner)
      expect(entry.observedForkRuns + entry.observedUpstreamRuns).toBeGreaterThan(0)
      // Why: a title with neither field absorbs any failure of that spec, which is the looseness
      // #317 removed. `match` pins an observed cause; `flaky: true` declares there is none to pin.
      expect(
        typeof entry.match === 'string' || entry.flaky === true,
        `${entry.file} › ${entry.title} has neither a match nor flaky: true`
      ).toBe(true)
      if (typeof entry.match === 'string') {
        expect(() => new RegExp(entry.match), `${entry.file} has an unusable match`).not.toThrow()
      }
    }
    expect(new Set(manifest.titles.map((entry) => `${entry.file} › ${entry.title}`)).size).toBe(
      manifest.titles.length
    )
  })

  it('names only spec files this tree still has, so a rename cannot silently un-record a red', () => {
    for (const entry of manifest.titles) {
      expect(existsSync(join(projectDir, entry.file)), `${entry.file} does not exist`).toBe(true)
    }
  })
})
