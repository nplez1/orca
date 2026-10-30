import { readFileSync } from 'node:fs'
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
    // The claim lived in a comment, which a YAML parse drops, so read the file itself.
    const text = readFileSync(
      new URL('../../.github/workflows/fork-release.yml', import.meta.url),
      'utf8'
    )

    expect(text).not.toContain('Tests and lint are deliberately not run here')
    expect(text).toContain('nothing publishes without the unit')
  })

  it('nothing in the file can skip or soften the gate', () => {
    const text = readFileSync(
      new URL('../../.github/workflows/fork-release.yml', import.meta.url),
      'utf8'
    )

    // Not just the legs: a `continue-on-error` or an `if:` on the suite job would open the same hole.
    expect(text).not.toContain('continue-on-error')
    for (const job of Object.values(RELEASE.jobs)) {
      expect(job.if).toBeUndefined()
    }
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

describe('a release does not go public without its change summary', () => {
  const text = () =>
    readFileSync(new URL('../../.github/workflows/fork-release.yml', import.meta.url), 'utf8')

  it('fails the run instead of substituting a minimal body', () => {
    // The old step printed `**Orca NP <version>** / Built from <sha>` and carried on, which is the
    // install-instructions-only release the generator exists to remove.
    expect(text()).not.toContain('publishing a minimal body instead')
    expect(text()).not.toContain('Built from `%s`')
  })

  it('guards the generated notes before anything is created', () => {
    const steps = RELEASE.jobs.macos.steps
    const notes = steps.findIndex((step) =>
      (step.run ?? '').includes('fork-release-notes-guard.mjs /tmp/notes.md')
    )
    const create = steps.findIndex((step) => (step.run ?? '').includes('gh release create'))

    expect(notes).toBeGreaterThan(-1)
    // Before the draft exists, so a refusal leaves no tag and no assets behind to clean up.
    expect(notes).toBeLessThan(create)
  })

  it('re-checks the body of the release it is about to undraft', () => {
    const publish = runScripts(RELEASE).find((run) => run.includes('--draft=false')) ?? ''

    expect(publish).toContain('fork-release-notes-guard.mjs -')
    // The check has to gate the undraft, not follow it.
    expect(publish.indexOf('fork-release-notes-guard.mjs')).toBeLessThan(
      publish.indexOf('--draft=false')
    )
  })

  it('undrafts nowhere else, and only from the last platform leg', () => {
    const undrafting = Object.entries(RELEASE.jobs)
      .filter(([, job]) =>
        runScripts({ jobs: { job } }).some((run) => run.includes('--draft=false'))
      )
      .map(([name]) => name)

    expect(undrafting).toEqual(['linux'])
  })
})
