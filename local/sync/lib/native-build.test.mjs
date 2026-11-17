// Fixture test for the native row's discovery half: which directories under native/ are build roots.
// No Swift, no git:
//   node --test local/sync/lib/native-build.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { swiftBuildRoots } from './native-build.mjs'

const tree = {
  computer: ['Package.swift'],
  'notification-status': ['main.swift'],
  docs: ['README.md'],
  both: ['Package.swift', 'main.swift']
}

const has = (dir, file) => (tree[dir] ?? []).includes(file)

test('a Package.swift is a package root and a lone main.swift is a helper, discovered not listed', () => {
  assert.deepEqual(swiftBuildRoots(Object.keys(tree), has), [
    { kind: 'package', dir: 'both' },
    { kind: 'package', dir: 'computer' },
    { kind: 'helper', dir: 'notification-status' }
  ])
})

test('a directory with neither, or with no entries at all, is not a build root', () => {
  assert.deepEqual(swiftBuildRoots(['docs'], has), [])
  assert.deepEqual(swiftBuildRoots([], has), [])
})
