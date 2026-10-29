import { describe, expect, it } from 'vitest'
import { needsOf, readWorkflow, runScripts, triggerKeys } from './workflow-file.mjs'

const RELEASE = readWorkflow('.github/workflows/fork-release.yml')
const UNIT = readWorkflow('.github/workflows/unit-tests.yml')

/** Every job a job waits on, transitively — publishing is anything the artifact legs depend on. */
function ancestors(job, seen = new Set()) {
  for (const need of needsOf(RELEASE, job)) {
    if (!seen.has(need)) {
      seen.add(need)
      ancestors(need, seen)
    }
  }
  return seen
}

const PUBLISHING = ['macos', 'windows', 'linux']

describe('the release dispatch is gated on test evidence', () => {
  it('has a job that runs the fork unit suite', () => {
    const suiteJob = Object.entries(RELEASE.jobs).find(
      ([, job]) => job.uses === './.github/workflows/unit-tests.yml'
    )

    expect(suiteJob?.[0]).toBe('unit-tests')
  })

  it('every artifact leg waits for the suite, transitively', () => {
    for (const job of PUBLISHING) {
      expect([...ancestors(job)], job).toContain('unit-tests')
    }
  })

  it('runs the same lane the nightly does, not a lookalike', () => {
    const with_ = RELEASE.jobs['unit-tests'].with
    const nightly = readWorkflow('.github/workflows/fork-main-tests.yml').jobs.test.with

    expect(with_.node_versions).toBe(nightly.node_versions)
    expect(with_.runner).toBe(nightly.runner)
    expect(with_.run_relay_integration).toBe(nightly.run_relay_integration)
    // The shard plan is the workflow's own job, so it is the plan every other lane runs.
    expect(RELEASE.jobs['unit-tests'].with.shards).toContain('needs.unit-plan.outputs.shards')
    expect(runScripts(RELEASE).join('\n')).toContain('config/scripts/ci-unit-plan.mjs')
  })

  it('calls a workflow that can actually be called', () => {
    expect(triggerKeys(UNIT.on)).toContain('workflow_call')
  })

  it('no longer says tests are not run here', () => {
    const text = JSON.stringify(RELEASE)

    expect(text).not.toContain('Tests and lint are deliberately not run here')
  })

  it('keeps the artifact legs serialized, which is why they share one release', () => {
    expect(needsOf(RELEASE, 'windows')).toContain('macos')
    expect(needsOf(RELEASE, 'linux')).toContain('windows')
  })

  it('still refuses any ref but the release line', () => {
    const guard = runScripts(RELEASE).join('\n')

    expect(guard).toContain('fork-release-ref-guard.sh')
    expect(needsOf(RELEASE, 'unit-tests')).toContain('release-ref')
  })
})
