import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * This fork records the scheduled E2E failures it inherits from upstream, and lets the verdict step
 * decide a shard's result so those stop failing the run. The wiring is what keeps that from becoming
 * "the fork ignores E2E": it must stay out of upstream's runs, out of the PR lane, and off
 * Playwright's own exit code for a failure nobody recorded.
 */
const projectDir = resolve(import.meta.dirname, '../..')
const workflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
const manifest = JSON.parse(
  readFileSync(join(projectDir, 'local/e2e-known-failure-titles.json'), 'utf8')
)
const step = (name) => workflow.jobs.e2e.steps.find((candidate) => candidate.name === name)

describe('known-failure verdict wiring', () => {
  it('keeps Playwright in charge upstream and hands a fork shard to the verdict', () => {
    const run = step('Run E2E tests (${{ matrix.shard_name }})')
    expect(run['continue-on-error']).toBe("${{ github.repository != 'stablyai/orca' }}")
    expect(run.run).toContain('REPORT_ARGS=(--reporter=list,json)')
    expect(run.run).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME="$GITHUB_WORKSPACE/ci-shards/report.json"')
    expect(run.run).toContain('"${REPORT_ARGS[@]}"')
    expect(run.run).toContain('if [ "${{ github.repository }}" != "stablyai/orca" ]')
  })

  it('reads the report rather than the test step’s conclusion', () => {
    const verdict = step('Verdict on known failures (${{ matrix.shard_name }})')
    expect(verdict.if).toBe(
      "${{ github.repository != 'stablyai/orca' && steps.run-e2e.outcome != 'skipped' }}"
    )
    expect(verdict.run).toBe(
      'node local/check-e2e-known-failure-titles.mjs ci-shards/report.json local/e2e-known-failure-titles.json'
    )
    const traces = step('Upload Playwright traces')
    expect(traces.if).toBe("steps.run-e2e.outcome == 'failure'")
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
    expect(manifest.titles.length).toBeGreaterThan(0)
    for (const entry of manifest.titles) {
      expect(entry.file).toMatch(/^tests\/e2e\/[^/]+\.spec\.ts$/)
      expect(entry.title.length).toBeGreaterThan(0)
      expect(['upstream', 'unattributed']).toContain(entry.owner)
      expect(entry.observedForkRuns + entry.observedUpstreamRuns).toBeGreaterThan(0)
    }
    expect(new Set(manifest.titles.map((entry) => `${entry.file} › ${entry.title}`)).size).toBe(
      manifest.titles.length
    )
  })
})
