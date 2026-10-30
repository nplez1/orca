import { describe, expect, it } from 'vitest'
import { needsOf, readWorkflow, runScripts, triggerKeys } from './workflow-file.mjs'

const GATES = readWorkflow('.github/workflows/fork-pr-gates.yml')

describe('the cheap PR lane', () => {
  it('runs on pull requests, not only on a human dispatch', () => {
    expect(triggerKeys(GATES.on)).toEqual(
      expect.arrayContaining(['pull_request', 'workflow_dispatch'])
    )
  })

  it('is the two gates the ledger decided on, named so a ruleset can require them', () => {
    expect(Object.keys(GATES.jobs)).toEqual(['typecheck', 'changed-lines'])
    // The ruleset matches a check by name, so the names carry the lane's identity.
    expect(GATES.jobs.typecheck.name).toBe('fork-pr-gates: typecheck')
    expect(GATES.jobs['changed-lines'].name).toBe('fork-pr-gates: changed lines')
    expect(runScripts(GATES)).toContainEqual(expect.stringContaining('pnpm tc'))
    expect(runScripts(GATES)).toContainEqual(
      expect.stringContaining('pnpm run check:code-quality:changed')
    )
  })

  it('does not run the repo-wide lint lane while the release line is red for it', () => {
    // `pnpm lint` reports 2 of 36 steps failed on nplez1/main (oxlint over max-lines in the CLI, and a
    // stale flaky-test baseline). A permanently red required check is worse than no check.
    const scripts = runScripts(GATES).join('\n')

    expect(scripts).not.toMatch(/^ {2}pnpm lint$|pnpm run lint$/m)
    expect(scripts).toContain('check:code-quality:changed')
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

    expect(checkouts.map((stepWith) => stepWith['fetch-depth'])).toEqual([undefined, 2])
  })

  it('does not carry the unit suite, which is a shard planner rather than a PR lane', () => {
    expect(needsOf(GATES, 'typecheck')).toEqual([])
    expect(runScripts(GATES).join('\n')).not.toContain('config/scripts/ci-unit-plan.mjs')
  })
})
