import { describe, expect, it } from 'vitest'
import { needsOf, readWorkflow, runScripts, triggerKeys } from './workflow-file.mjs'

const GATES = readWorkflow('.github/workflows/fork-pr-gates.yml')

describe('the cheap PR lane', () => {
  it('runs on pull requests, not only on a human dispatch', () => {
    expect(triggerKeys(GATES.on)).toEqual(
      expect.arrayContaining(['pull_request', 'workflow_dispatch'])
    )
  })

  it('is the three gates the ledger decided on, named so a ruleset can require them', () => {
    expect(Object.keys(GATES.jobs)).toEqual(['typecheck', 'changed-lines', 'lint'])
    // The ruleset matches a check by name, so the names carry the lane's identity.
    expect(GATES.jobs.typecheck.name).toBe('fork-pr-gates: typecheck')
    expect(GATES.jobs['changed-lines'].name).toBe('fork-pr-gates: changed lines')
    expect(GATES.jobs.lint.name).toBe('fork-pr-gates: lint gate')
    expect(runScripts(GATES)).toContainEqual(expect.stringContaining('pnpm tc'))
    expect(runScripts(GATES)).toContainEqual(
      expect.stringContaining('pnpm run check:code-quality:changed')
    )
    expect(runScripts(GATES)).toContainEqual(expect.stringContaining('node local/gate-lint.mjs'))
  })

  it('runs the lint verdict, not `pnpm lint`, which cannot pass on a base that carries reds', () => {
    // `pnpm lint` names every failing step, so attribution is not the reason to prefer the gate: it
    // has no notion of a known red, and it never runs `FORK_LINT_STEPS`. `local/gate-lint.mjs` runs
    // both and classifies them against `local/lint-known-red.json`, so a foreign red passes and a new
    // one fails. A permanently red required check is worse than no check.
    const scripts = runScripts(GATES).join('\n')

    expect(scripts).not.toMatch(/^ {2}pnpm lint$|pnpm run lint$/m)
    expect(scripts).toContain('node local/gate-lint.mjs')
  })

  it('needs nothing beyond read access, because nothing it runs writes', () => {
    expect(GATES.permissions).toEqual({ contents: 'read' })
    expect(runScripts(GATES).join('\n')).not.toContain('--publish')
  })

  it('cancels a superseded run instead of paying for both', () => {
    expect(GATES.concurrency['cancel-in-progress']).toBe(true)
  })

  it('checks out the base the diff gate needs, and nothing shallow', () => {
    const checkouts = Object.values(GATES.jobs).map((job) => job.steps[0].with)

    // The lint job diffs a merge commit against its first parent for the same reason.
    expect(checkouts.map((stepWith) => stepWith['fetch-depth'])).toEqual([undefined, 2, 2])
  })

  it('does not carry the unit suite, which is a shard planner rather than a PR lane', () => {
    expect(needsOf(GATES, 'typecheck')).toEqual([])
    expect(needsOf(GATES, 'lint')).toEqual([])
    expect(runScripts(GATES).join('\n')).not.toContain('config/scripts/ci-unit-plan.mjs')
  })

  it('gives the lint gate the sync base its fork-comment ratchet measures against', () => {
    // `check-upstream-file-comments` measures against the commit the baseline records, and a CI
    // checkout has no such commit. Without this fetch the gate is red for a missing object rather
    // than for a finding — the class of red this lane exists to keep meaningful.
    const steps = GATES.jobs.lint.steps
    const fetchIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('upstream-file-comments-baseline.json')
    )
    const gateIndex = steps.findIndex((step) => (step.run ?? '').includes('gate-lint.mjs'))

    expect(fetchIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(fetchIndex)
  })
})
