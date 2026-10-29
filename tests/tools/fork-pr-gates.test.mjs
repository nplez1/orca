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
    expect(Object.keys(GATES.jobs)).toEqual(['typecheck', 'lint'])
    expect(GATES.jobs.typecheck.name).toBe('typecheck')
    expect(GATES.jobs.lint.name).toBe('lint')
    expect(runScripts(GATES)).toContainEqual(expect.stringContaining('pnpm tc'))
    expect(runScripts(GATES)).toContainEqual(expect.stringContaining('oxlint'))
  })

  it('needs nothing beyond read access, because nothing it runs writes', () => {
    expect(GATES.permissions).toEqual({ contents: 'read' })
    expect(runScripts(GATES).join('\n')).not.toContain('--publish')
  })

  it('cancels a superseded run instead of paying for both', () => {
    expect(GATES.concurrency['cancel-in-progress']).toBe(true)
  })

  it('does not carry the unit suite, which is a shard planner rather than a PR lane', () => {
    expect(needsOf(GATES, 'typecheck')).toEqual([])
    expect(runScripts(GATES).join('\n')).not.toContain('config/scripts/ci-unit-plan.mjs')
  })
})
