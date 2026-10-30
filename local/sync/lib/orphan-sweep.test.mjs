// Fixture tests for the fork-only orphan sweep. No git, no filesystem:
//   node --test local/sync/lib/orphan-sweep.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { isSweepCandidate, orphanForkFiles, resolveSpecifier } from './orphan-sweep.mjs'

const sources = (entries) => new Map(Object.entries(entries))
const known = (...paths) => new Set(paths)

test('resolves a relative import, with and without an extension', () => {
  const tree = known('src/shared/a.ts', 'src/shared/b.ts')
  assert.equal(resolveSpecifier('./a', 'src/shared/b.ts', tree), 'src/shared/a.ts')
  assert.equal(resolveSpecifier('./a.ts', 'src/shared/b.ts', tree), 'src/shared/a.ts')
})

test('resolves a directory import through its index', () => {
  assert.equal(
    resolveSpecifier('./dir', 'src/shared/b.ts', known('src/shared/dir/index.ts')),
    'src/shared/dir/index.ts'
  )
})

test('resolves the renderer aliases', () => {
  const tree = known('src/renderer/src/lib/a.ts')
  assert.equal(resolveSpecifier('@/lib/a', 'src/main/x.ts', tree), 'src/renderer/src/lib/a.ts')
  assert.equal(
    resolveSpecifier('@renderer/lib/a', 'src/main/x.ts', tree),
    'src/renderer/src/lib/a.ts'
  )
})

test('returns null for a package, which is not a repo path', () => {
  assert.equal(resolveSpecifier('electron', 'src/main/x.ts', known('src/main/x.ts')), null)
})

test('returns null when nothing on disk matches, rather than guessing a path', () => {
  assert.equal(resolveSpecifier('./nope', 'src/main/x.ts', known('src/main/x.ts')), null)
})

test('reports a fork-only file nothing imports', () => {
  const orphans = orphanForkFiles({
    sources: sources({
      'src/main/entry.ts': "import { a } from './used'",
      'src/main/used.ts': 'export const a = 1',
      'src/main/dead.ts': 'export const dead = 1'
    }),
    forkOnly: ['src/main/used.ts', 'src/main/dead.ts']
  })
  assert.deepEqual(orphans, ['src/main/dead.ts'])
})

test('counts a reference from outside src/, so a config script keeps a module alive', () => {
  const orphans = orphanForkFiles({
    sources: sources({
      'config/scripts/uses-it.mjs': "import { a } from '../../src/shared/mine.ts'",
      'src/shared/mine.ts': 'export const a = 1'
    }),
    forkOnly: ['src/shared/mine.ts']
  })
  assert.deepEqual(orphans, [])
})

test('does not report a cycle of two files that only import each other', () => {
  const orphans = orphanForkFiles({
    sources: sources({
      'src/a.ts': "import './b'",
      'src/b.ts': "import './a'"
    }),
    forkOnly: ['src/a.ts', 'src/b.ts']
  })
  // Each is referenced by the other, so neither is an orphan: the sweep cannot tell a cycle of dead
  // code from a live pair, and reporting both is noise a reader learns to ignore.
  assert.deepEqual(orphans, [])
})

test('honours the allowlist for entries loaded by path, not by specifier', () => {
  const orphans = orphanForkFiles({
    sources: sources({ 'src/main/entry.ts': 'export const a = 1' }),
    forkOnly: ['src/main/entry.ts', 'src/main/worker-entry.ts'],
    allowlist: ['src/main/worker-entry.ts']
  })
  assert.deepEqual(orphans, ['src/main/entry.ts'])
})

test('sorts the result so two runs are diffable', () => {
  const orphans = orphanForkFiles({
    sources: sources({}),
    forkOnly: ['src/z.ts', 'src/a.ts', 'src/m.ts']
  })
  assert.deepEqual(orphans, ['src/a.ts', 'src/m.ts', 'src/z.ts'])
})

test('isSweepCandidate takes fork-only source under src/ and leaves out tests and fixtures', () => {
  assert.equal(isSweepCandidate('src/shared/a.ts'), true)
  assert.equal(isSweepCandidate('src/shared/a.test.ts'), false)
  assert.equal(isSweepCandidate('src/shared/a.spec.tsx'), false)
  assert.equal(isSweepCandidate('src/shared/a.fixture.tsx'), false)
  assert.equal(isSweepCandidate('local/sync/x.mjs'), false)
})

test('a .js specifier in a TS file resolves to the .ts module beside it', () => {
  assert.equal(
    resolveSpecifier(
      './handlers/connector.js',
      'src/cli/handler-group-manifest.ts',
      known('src/cli/handlers/connector.ts')
    ),
    'src/cli/handlers/connector.ts'
  )
  assert.equal(
    resolveSpecifier('./thing.mjs', 'src/a/b.mjs', known('src/a/thing.mts')),
    'src/a/thing.mts'
  )
})
