// Fixture tests for the whole-file gate a fully proven resolution must pass. No git, no filesystem:
//   node --test local/sync/lib/conflict-file-gate.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { modulePaths, resolvesInIndex } from './conflict-file-gate.mjs'
import { indexModuleOracle } from './conflict-index.mjs'
import { proveFile } from './conflict-prove.mjs'
import { everyModule, file, hunk, proveWithIndex } from './conflict-test-fixtures.mjs'
import { parseSource } from './ts-source.mjs'

test('a proven file is not written while a module path in it resolves to nothing the merge keeps', () => {
  // Upstream moved the file one directory down; the fork's added import is relative to the old home.
  const path = 'src/cli/runtime/profile/launch-user-data-path.ts'
  const merged = (forkSpecifier) =>
    file(
      hunk({
        ours: ["import { E } from '../../shared/env'", `import { D } from '${forkSpecifier}'`],
        base: ["import { E } from '../../shared/env'"],
        theirs: ["import { E } from '../../../shared/remote/env'"]
      }),
      "import { m } from './metadata'"
    )
  const index = new Set([
    'src/shared/remote/env.ts',
    'src/shared/app-directory-names.ts',
    'src/cli/runtime/profile/metadata.ts'
  ])
  const stale = proveWithIndex(path, merged('../../shared/app-directory-names'), (at) =>
    index.has(at)
  )
  assert.equal(stale.provenHunks, 1)
  assert.equal(stale.fullyProven, false)
  assert.equal(stale.resolvedText, undefined)
  assert.deepEqual(stale.unresolvedModules, ['../../shared/app-directory-names'])
  const rebased = proveWithIndex(path, merged('../../../shared/app-directory-names'), (at) =>
    index.has(at)
  )
  assert.equal(rebased.fullyProven, true)
  // No index to check against is a refusal, not a pass.
  assert.equal(
    proveFile({ path, merged: merged('../../../shared/app-directory-names') }).fullyProven,
    false
  )
})

test('a proven file is not written while it imports a binding one side removed outside the hunk', () => {
  // Git's clean merge placed upstream's moved copy of `m` above the hunk; the fork had deleted it.
  const merged = file(
    "import { m } from './new/m'",
    hunk({
      ours: ["import { k } from './k'"],
      base: ["import { k } from './k'", "import { m } from './m'"],
      theirs: ["import { k } from './k'", "import { u } from './u'"]
    })
  )
  const stages = {
    base: file("import { k } from './k'", "import { m } from './m'"),
    ours: file("import { k } from './k'"),
    theirs: file(
      "import { m } from './new/m'",
      "import { k } from './k'",
      "import { u } from './u'"
    )
  }
  const result = proveWithIndex('src/a.ts', merged, everyModule, stages)
  assert.equal(result.provenHunks, 1)
  assert.equal(result.fullyProven, false)
  assert.match(result.reason, /imports what one side removed: m$/)
})

test('module paths are read from every import form and resolved like the compiler would', () => {
  const { sf } = parseSource(
    'src/renderer/src/a.test.ts',
    [
      "import { a } from './a.js'",
      "export { b } from '../b'",
      "import pkg from 'react'",
      "vi.mock('@/store/c', () => ({}))",
      "const d = await import('./d')",
      "type E = typeof import('./e')"
    ].join('\n')
  )
  assert.deepEqual(modulePaths(sf), ['./a.js', '../b', '@/store/c', './d', './e'])
  const index = new Set([
    'src/renderer/src/a.ts',
    'src/renderer/b/index.tsx',
    'src/renderer/src/store/c.ts'
  ])
  const exists = (at) => index.has(at)
  assert.equal(resolvesInIndex('src/renderer/src/a.test.ts', './a.js', exists), true)
  assert.equal(resolvesInIndex('src/renderer/src/a.test.ts', '../b', exists), true)
  assert.equal(resolvesInIndex('src/main/x.ts', '@/store/c', exists), true)
  assert.equal(resolvesInIndex('src/renderer/src/a.test.ts', './d', exists), false)
  assert.equal(resolvesInIndex('src/a.ts', '../../outside', exists), false)
})

test('the index keeps a stage-0 path or a both-sides conflict, never a modify/delete', () => {
  const record = (mode, stage, path) => `${mode} ${'a'.repeat(40)} ${stage}\t${path}`
  const exists = indexModuleOracle(
    [
      record('100644', 0, 'src/clean.ts'),
      ...[1, 2, 3].map((stage) => record('100644', stage, 'src/both.ts')),
      ...[1, 2].map((stage) => record('100644', stage, 'src/fork-kept-upstream-deleted.ts')),
      ''
    ].join('\u0000')
  )
  assert.deepEqual(
    ['src/clean.ts', 'src/both.ts', 'src/fork-kept-upstream-deleted.ts', 'src/absent.ts'].map(
      exists
    ),
    [true, true, false, false]
  )
})
