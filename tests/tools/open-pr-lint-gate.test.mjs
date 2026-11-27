import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeLintVerdict } from '../../local/gate-lint-verdict.mjs'
import { evaluateGates, lintGateProblem, parseGateWaivers } from '../../local/open-pr.mjs'
import { REVIEW_CLAIM_EXAMPLE } from '../../local/pr-body-claims.mjs'

// Gate 3 of `local/open-pr.mjs`: the lint verdict. Kept apart from `open-pr.test.mjs`, which is at
// its line budget; the gate 1 and 2 tests there answer gate 3 with an injected green reader.

const REVISION = 'a'.repeat(40)
const LINT_GREEN = { lintProblem: () => null }
const dirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'open-pr-lint-gate-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('refuses a fork PR with no lint verdict, and names the fast loop to iterate with', () => {
  const asked = []
  const refused = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    changedPaths: ['src/main/foo.ts'],
    lintProblem: (head) => {
      asked.push(head)
      return 'no green lint verdict for abc; run it first: orca-queue node local/gate-lint.mjs'
    }
  })
  expect(asked).toEqual([REVISION])
  expect(refused.problems).toEqual([
    expect.stringContaining('gate 3 (lint): no green lint verdict')
  ])
  expect(refused.problems[0]).toContain('gate-lint.mjs --fast')

  const passed = evaluateGates({
    ...LINT_GREEN,
    waivers: new Map(),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    changedPaths: ['src/main/foo.ts']
  })
  expect(passed.problems).toEqual([])
  expect(passed.passes.at(-1)).toContain('gate 3 PASS')

  const waived = evaluateGates({
    waivers: parseGateWaivers(['3:linted on CI at this head']),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    changedPaths: ['src/main/foo.ts'],
    lintProblem: () => 'never asked'
  })
  expect(waived.problems).toEqual([])
  expect(waived.waived).toEqual([[3, 'linted on CI at this head']])
})

it('does not ask for a lint verdict on an upstream PR', () => {
  const result = evaluateGates({
    upstream: true,
    waivers: parseGateWaivers(['1:upstream PR, gated by upstream CI']),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    lintProblem: () => 'should not be read'
  })
  expect(result.problems).toEqual([])
  expect(result.passes.at(-1)).toContain('gate 3 not required')
})

it('reads gate 3 from the lint marker a full gate-lint PASS writes', () => {
  const commonDir = tempDir()
  const noGit = () => {
    throw new Error('no repository')
  }
  expect(lintGateProblem(REVISION, { commonDir, git: noGit })).toContain('no green lint verdict')
  writeLintVerdict({
    gitCommonDir: commonDir,
    revision: REVISION,
    steps: [{ id: 'oxlint', exitCode: 0 }]
  })
  expect(lintGateProblem(REVISION, { commonDir, git: noGit })).toBeNull()
})
