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
    // Path-agnostic on purpose: upstream moves these scripts, and the claim is that the release
    // plans its shards with the nightly's planner, not with a lookalike that happens to exist.
    const nightlyPlan = runScripts(readWorkflow('.github/workflows/fork-main-tests.yml')).find(
      (script) => script.includes('ci-unit-plan.mjs')
    )
    expect(nightlyPlan, 'the nightly must plan its shards with ci-unit-plan.mjs').toBeDefined()
    expect(runScripts(RELEASE).join('\n')).toContain(nightlyPlan)
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
    // Every verdict that gates a publish is named in the claim, not just the suite it started with.
    const header = text.slice(0, text.indexOf('\njobs:'))
    expect(header).toContain('Nothing publishes without evidence')
    for (const gate of ['unit-tests', 'typecheck', 'lint']) {
      expect(header, gate).toContain(gate)
    }
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

describe('the release dispatch is gated on the compiler and the lint verdict', () => {
  const scripts = (name) => runScripts({ jobs: { job: RELEASE.jobs[name] } })

  it('typechecks the commit it is about to publish, with the command the other lanes run', () => {
    const mainGate = readWorkflow('.github/workflows/fork-main-gates.yml').jobs.gates.steps.find(
      (step) => step.name === 'Typecheck'
    )

    // Why against the other two lanes rather than a literal: `tc:node` here would be a green about a
    // third of the tree, and the point of the job is that green means what green means elsewhere.
    const prGate = readWorkflow('.github/workflows/fork-pr-gates.yml').jobs.typecheck

    expect(mainGate?.run).toBe('pnpm tc')
    expect(runScripts({ jobs: { job: prGate } })).toEqual(['pnpm tc'])
    expect(scripts('typecheck')).toEqual(['pnpm tc'])
  })

  it('runs the fork lint verdict, which is the one form green on a base carrying foreign reds', () => {
    expect(scripts('lint')).toContain('node local/gate-lint.mjs')
  })

  it('fetches the recorded sync base before the verdict, or the comment ratchet cannot run', () => {
    const steps = RELEASE.jobs.lint.steps
    const fetched = steps.findIndex((step) =>
      (step.run ?? '').includes('upstream-file-comments-baseline.json')
    )
    const verdict = steps.findIndex((step) => (step.run ?? '').includes('node local/gate-lint.mjs'))

    expect(fetched).toBeGreaterThan(-1)
    expect(fetched).toBeLessThan(verdict)
  })

  it('tells the verdict where its diff base is, so a shallow checkout cannot red it', () => {
    const verdict = RELEASE.jobs.lint.steps.find((step) =>
      (step.run ?? '').includes('node local/gate-lint.mjs')
    )

    expect(verdict?.env?.ORCA_CODE_QUALITY_BASE).toBe('HEAD')
  })

  it('every artifact leg waits for both verdicts, not only the first one in the chain', () => {
    // `windows` and `linux` would inherit them through `macos`; naming both anyway is what keeps the
    // gate when the upload-race serialization is relaxed.
    for (const job of PUBLISHING) {
      expect(needsOf(RELEASE, job), job).toContain('typecheck')
      expect(needsOf(RELEASE, job), job).toContain('lint')
    }
  })

  it('gives neither verdict job the release token', () => {
    for (const job of ['typecheck', 'lint']) {
      expect(RELEASE.jobs[job].permissions, job).toEqual({ contents: 'read' })
    }
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
