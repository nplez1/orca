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

const LEGS = ['macos', 'windows', 'linux']
/** Every job that creates, uploads into or undrafts the release. */
const PUBLISHING = ['release-draft', ...LEGS, 'publish']

describe('the release dispatch is gated on test evidence', () => {
  it('has a job that runs the fork unit suite', () => {
    const suiteJob = Object.entries(RELEASE.jobs).find(
      ([, job]) => job.uses === './.github/workflows/unit-tests.yml'
    )

    expect(suiteJob?.[0]).toBe('unit-tests')
  })

  it('every publishing job waits for the suite, transitively', () => {
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
    // Backticked, so the word appearing in prose does not satisfy the pin.
    for (const gate of ['`unit-tests`', '`typecheck`', '`lint`']) {
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

  it('runs the legs in parallel, behind the one job that creates the draft', () => {
    // Why: electron-builder creates the release itself when its listing finds none, so a leg that
    // could start before the draft exists would race the others to create it.
    for (const leg of LEGS) {
      expect(needsOf(RELEASE, leg), leg).toContain('release-draft')
      for (const other of LEGS) {
        expect([...ancestors(leg)], `${leg} waits for ${other}`).not.toContain(other)
      }
    }
    for (const leg of LEGS) {
      expect([...ancestors('release-draft')], leg).not.toContain(leg)
    }
  })

  it('derives the version once, in the job that guards it, and every later job reads that', () => {
    const text = readFileSync(
      new URL('../../.github/workflows/fork-release.yml', import.meta.url),
      'utf8'
    )
    expect(text.match(/GITHUB_RUN_NUMBER/g)).toHaveLength(1)
    expect(RELEASE.jobs['release-ref'].outputs.version).toContain('steps.guard.outputs.version')
    for (const job of PUBLISHING) {
      expect(RELEASE.jobs[job].env?.RELEASE_VERSION, job).toBe(
        '${{ needs.release-ref.outputs.version }}'
      )
    }
  })

  it('refuses an empty version in every job that reads it', () => {
    for (const job of PUBLISHING.filter((name) => name !== 'publish')) {
      const scripts = runScripts({ jobs: { job: RELEASE.jobs[job] } }).join('\n')
      expect(scripts, job).toContain('if [ -z "$RELEASE_VERSION" ]; then')
    }
  })

  it('never runs two releases at once, and never cancels one mid-upload', () => {
    expect(RELEASE.concurrency).toEqual({ group: 'fork-release', 'cancel-in-progress': false })
  })

  it('creates the release in exactly one job, and never in a leg', () => {
    const creating = Object.entries(RELEASE.jobs)
      .filter(([, job]) =>
        runScripts({ jobs: { job } }).some((run) => run.includes('gh release create'))
      )
      .map(([name]) => name)

    expect(creating).toEqual(['release-draft'])
  })

  it('refuses to upload into a release that is already published', () => {
    // electron-builder skips the upload to a published release under `releaseType: draft`, with
    // exit 0, so a run into one would be green and replace nothing.
    const create = runScripts({ jobs: { job: RELEASE.jobs['release-draft'] } }).find((run) =>
      run.includes('gh release create')
    )

    expect(create).toContain('--json isDraft')
    expect(create).toContain('is already published')
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

  it('every publishing job names both verdicts, not only the first job that waits for them', () => {
    // Each would inherit them through `release-draft`; naming them anyway is what keeps the gate the
    // day that job's own `needs` change.
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

  it('prepares both verdict jobs the way the other lanes prepare theirs', () => {
    for (const job of ['typecheck', 'lint']) {
      const install = RELEASE.jobs[job].steps.find(
        (step) => step.uses === './.github/actions/install-node-dependencies'
      )

      expect(install?.with?.['native-runtime'], job).toBe('node')
    }
  })

  it('judges the dispatched commit, never a ref of its own', () => {
    // A `ref:` would let a verdict pass on one revision while a different one is published.
    for (const [name, job] of Object.entries(RELEASE.jobs)) {
      for (const step of job.steps ?? []) {
        if (String(step.uses ?? '').startsWith('actions/checkout@')) {
          expect(step.with?.ref, name).toBeUndefined()
        }
      }
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
    const steps = RELEASE.jobs['release-draft'].steps
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

  it('undrafts in one job, and only once every platform leg is done', () => {
    const undrafting = Object.entries(RELEASE.jobs)
      .filter(([, job]) =>
        runScripts({ jobs: { job } }).some((run) => run.includes('--draft=false'))
      )
      .map(([name]) => name)

    expect(undrafting).toEqual(['publish'])
    for (const leg of LEGS) {
      expect(needsOf(RELEASE, 'publish'), leg).toContain(leg)
    }
  })

  it('lets a validation run skip only the undraft, after every check', () => {
    const publish = runScripts(RELEASE).find((run) => run.includes('--draft=false')) ?? ''
    const skip = publish.indexOf('KEEP_DRAFT')

    expect(RELEASE.on.workflow_dispatch.inputs.keep_draft.default).toBe(false)
    expect(skip).toBeGreaterThan(publish.indexOf('fork-release-notes-guard.mjs'))
    expect(skip).toBeLessThan(publish.indexOf('--draft=false'))
  })

  it('reads whether the release is a draft in a way a gh failure cannot pass', () => {
    // `set -e` does not trip on a failure inside a `[` argument, so an inline read failed open.
    const publish = runScripts(RELEASE).find((run) => run.includes('--draft=false')) ?? ''

    expect(publish).toMatch(/^\s*draft="\$\(gh release view [^\n]*--json isDraft/m)
    expect(publish).not.toMatch(/\[ "\$\(gh release view/)
    expect(publish).toContain('if [ "$draft" = "false" ]; then')
    expect(publish).toContain('if [ "$draft" != "true" ]; then')
    expect(publish).toMatch(/^\s*set -euo pipefail$/m)
  })

  it('checks every platform manifest before the undraft', () => {
    const scripts = runScripts({ jobs: { job: RELEASE.jobs.publish } }).join('\n')

    for (const manifest of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
      expect(scripts, manifest).toContain(manifest)
    }
    expect(scripts.indexOf('latest-linux.yml')).toBeLessThan(scripts.indexOf('--draft=false'))
  })

  it('reads full history wherever the notes or the tags are read', () => {
    // The notes span a rebase, and the guard compares against published tags: a one-commit clone
    // has neither. The legs need neither, so they keep the cheap clone.
    for (const job of ['release-ref', 'release-draft', 'publish']) {
      const checkout = RELEASE.jobs[job].steps.find((step) =>
        String(step.uses ?? '').startsWith('actions/checkout@')
      )
      expect(checkout?.with?.['fetch-depth'], job).toBe(0)
    }
  })
})
