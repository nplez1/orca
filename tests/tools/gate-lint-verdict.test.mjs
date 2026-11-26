import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  lintMarkerPath,
  readLintVerdict,
  writeLintVerdict
} from '../../local/gate-lint-verdict.mjs'

const tempDirs = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-lint-verdict-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

const TIP = 'a'.repeat(40)
const steps = [
  { id: 'lint:oxlint', exitCode: 0 },
  { id: 'lint:ast-grep', exitCode: 0 }
]

it('records only a full, clean pass', () => {
  const dir = tempDir()
  expect(writeLintVerdict({ gitCommonDir: dir, revision: TIP, steps })).toMatchObject({
    revision: TIP,
    allPassed: true,
    failed: []
  })
  expect(readLintVerdict(dir, TIP)).toMatchObject({ revision: TIP, allPassed: true })
  expect(lintMarkerPath(dir, TIP)).toContain(TIP.slice(0, 12))

  const subset = tempDir()
  expect(
    writeLintVerdict({ gitCommonDir: subset, revision: TIP, steps, only: ['lint:oxlint'] })
  ).toBe(null)
  expect(readLintVerdict(subset, TIP)).toBe(null)

  const dirty = tempDir()
  expect(writeLintVerdict({ gitCommonDir: dirty, revision: TIP, steps, dirty: true })).toBe(null)
  expect(readLintVerdict(dirty, TIP)).toBe(null)
})

// The neutral walk that reads these markers is `neutralReachable`/`governingCachedVerdict` in
// `local/gate-verdict-cache.mjs`, covered against a real repository in tests/tools/gate-unit.test.mjs.
