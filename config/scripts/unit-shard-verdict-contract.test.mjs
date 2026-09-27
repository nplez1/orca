import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * This fork owns the unit shards' verdict so a Vitest worker teardown race (vitest-dev/vitest#11153)
 * stops failing a run whose tests all passed. The wiring is what keeps that from becoming "the fork
 * ignores unit failures": it must stay out of upstream's runs, read the report rather than Vitest's
 * exit code, and leave a real failure — or a missing report — failing.
 */
const projectDir = resolve(import.meta.dirname, '../..')
const workflow = parseYaml(
  readFileSync(join(projectDir, '.github/workflows/unit-tests.yml'), 'utf8')
)
const run = (name) => workflow.jobs.test.steps.find((candidate) => candidate.name === name)

describe('unit shard verdict wiring', () => {
  it('keeps Vitest in charge upstream and hands a fork shard to the verdict', () => {
    const step = run('Test shard')
    expect(step.id).toBe('run-unit-shard')
    expect(step['continue-on-error']).toBe("${{ github.repository != 'stablyai/orca' }}")
    expect(step.run).toContain('if [ "${{ github.repository }}" != "stablyai/orca" ]')
    expect(step.run).toContain(
      'REPORT_ARGS=(--reporter=default --reporter=json --outputFile.json=ci-shards/unit-report.json)'
    )
    expect(step.run).toContain('"${REPORT_ARGS[@]}"')
    // Why: tee opens the log before Vitest creates ci-shards/, and pipefail would surface that.
    expect(step.run).toContain('mkdir -p ci-shards')
    expect(step.run).toContain('2>&1 | tee ci-shards/unit-shard.log')
    expect(step.run).toContain('set -o pipefail')
  })

  it('reads the report rather than the test step’s conclusion', () => {
    const verdict = run('Verdict on the unit shard')
    expect(verdict.if).toBe(
      "${{ github.repository != 'stablyai/orca' && steps.run-unit-shard.outcome != 'skipped' }}"
    )
    expect(verdict.run).toBe(
      'node local/check-unit-shard-verdict.mjs ci-shards/unit-report.json ci-shards/unit-shard.log "${{ steps.run-unit-shard.outcome }}"'
    )
  })

  it('archives the report and log the verdict reads', () => {
    const upload = run('Upload unit shard assignment')
    expect(upload.if).toBe('always()')
    expect(upload.with.path).toBe('ci-shards/')
  })
})
