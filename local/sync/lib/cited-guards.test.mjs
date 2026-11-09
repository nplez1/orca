// Fixture tests for the cited-guards row: which citations are read, and which ones resolve.
// No git, no filesystem:
//   node --test local/sync/lib/cited-guards.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { extractCitedGuards, missingCitedGuards } from './cited-guards.mjs'

const tracked = [
  'src/main/thing.test.ts',
  'src/main/nested/deep.test.ts',
  'config/scripts/tool.test.mjs',
  'local/sync/lib/one.test.mjs',
  'local/sync/lib/two.test.mjs',
  'src/shared/plain.ts'
]
const scripts = { lint: 'x', 'check:code-quality:changed': 'y' }
const resolve = (markdown) =>
  missingCitedGuards({ cited: extractCitedGuards(markdown), tracked, scripts })

test('a cited test path that no tracked file matches fails, and is named', () => {
  const result = resolve('See `src/main/gone.test.ts` for the guard.')
  assert.deepEqual(result.missingPaths, ['src/main/gone.test.ts'])
  assert.equal(result.checkedPaths, 1)
})

test('a cited path that exists resolves', () => {
  assert.deepEqual(resolve('See `src/main/thing.test.ts`.').missingPaths, [])
})

test('a cited glob that matches nothing fails, and one that matches passes', () => {
  assert.deepEqual(resolve('Run `local/sync/lib/*.test.mjs`.').missingPaths, [])
  assert.deepEqual(resolve('Run `local/sync/lib/**/*.test.mjs`.').missingPaths, [])
  assert.deepEqual(resolve('Run `local/sync/lib/*.spec.mjs`.').missingPaths, [
    'local/sync/lib/*.spec.mjs'
  ])
})

test('a cited package script that package.json does not have fails', () => {
  const result = resolve('Run `pnpm run check:code-quality:changed` and `pnpm run rebuild:gone`.')
  assert.deepEqual(result.missingScripts, ['rebuild:gone'])
  assert.equal(result.checkedScripts, 2)
})

test('a script named in prose counts, which is the shape the ledger actually uses', () => {
  const result = resolve("`package.json`'s `rebuild:gone` script plus a shell file.")
  assert.deepEqual(result.missingScripts, ['rebuild:gone'])
  assert.deepEqual(resolve("`package.json`'s `lint` script.").missingScripts, [])
})

test('a bare colon token is not a script citation, and a pnpm verb is not one either', () => {
  const result = resolve(
    'It reads `node:sqlite`, `ssh:host-b` and `orca://`, and you run `pnpm install` and `pnpm exec oxlint`.'
  )
  assert.deepEqual(result.missingScripts, [])
  assert.equal(result.checkedScripts, 0)
  assert.equal(result.checkedPaths, 0)
})

test('a citation inside a longer command is not a path citation', () => {
  // `pnpm test src/main/thing.test.ts` is a command, not a bare path, so it is not extracted — the
  // shape has to be the path itself or the row would read every command line in the file.
  assert.equal(resolve('`pnpm test src/main/gone.test.ts`').checkedPaths, 0)
})
