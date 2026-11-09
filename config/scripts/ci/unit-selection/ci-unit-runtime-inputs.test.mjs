import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { unitRuntimeInputs } from './ci-unit-runtime-inputs.mjs'

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-runtime-inputs-'))
  dirs.push(dir)
  return dir
}

it('walks the imports of the files a setup file imports, not just its direct imports', () => {
  // Why two levels: one level is what a path rule cannot express, and the second is what a walk that
  // stops at the setup file's own imports would miss — the same hole one step further out (#316).
  const sources = new Map([
    [
      'config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts',
      "import { _reset } from '../../../../src/main/runtime/rpc/orcad-feature-readiness'"
    ],
    [
      'src/main/runtime/rpc/orcad-feature-readiness.ts',
      "import { phase } from '../../startup/phases'"
    ],
    ['src/main/startup/phases.ts', 'export const phase = 1'],
    ['src/main/unrelated.ts', 'export const unrelated = 1']
  ])
  const inputs = unitRuntimeInputs({
    root: tempRoot(),
    entries: ['config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts'],
    has: (file) => sources.has(file),
    read: (file) => sources.get(file)
  })
  expect([...inputs].sort()).toEqual([
    'src/main/runtime/rpc/orcad-feature-readiness.ts',
    'src/main/startup/phases.ts'
  ])
})
