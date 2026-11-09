import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { unitRuntimeInputs } from './ci-unit-runtime-inputs.mjs'

const dirs = []
const SETUP = 'config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts'

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

// Why real files and no injected reader: the default `has` and `read` are what open-pr uses, so a test
// that injects them cannot catch a default that throws on a directory or skips a real file.
function closure(sources) {
  const root = tempRoot()
  for (const [file, source] of sources) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  return [...unitRuntimeInputs({ root, entries: [SETUP] })].sort()
}

it('walks the imports of the files a setup file imports, not just its direct imports', () => {
  // Why two levels: one level is what a path rule cannot express, and the second is what a walk that
  // stops at the setup file's own imports would miss — the same hole one step further out (#316).
  expect(
    closure(
      new Map([
        [
          SETUP,
          "import { _reset } from '../../../../src/main/runtime/rpc/orcad-feature-readiness'"
        ],
        [
          'src/main/runtime/rpc/orcad-feature-readiness.ts',
          "import { phase } from '../../startup/phases'"
        ],
        ['src/main/startup/phases.ts', 'export const phase = 1'],
        ['src/main/unrelated.ts', 'export const unrelated = 1']
      ])
    )
  ).toEqual(['src/main/runtime/rpc/orcad-feature-readiness.ts', 'src/main/startup/phases.ts'])
})

it('keeps a barrel directory out of the closure and follows its index instead', () => {
  // Why: the empty resolution suffix makes the bare path a candidate, so without a file check the
  // directory is queued and then read as a file — which throws out of the PR opener.
  expect(
    closure(
      new Map([
        [SETUP, "import { value } from '../../../../src/main/barrel'"],
        ['src/main/barrel/index.ts', "export { value } from './value'"],
        ['src/main/barrel/value.ts', 'export const value = 1']
      ])
    )
  ).toEqual(['src/main/barrel/index.ts', 'src/main/barrel/value.ts'])
})
