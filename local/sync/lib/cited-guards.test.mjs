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

test('a path inside a cited command is read, because that is how the ledger cites a guard it runs', () => {
  const result = resolve('`pnpm test src/main/gone.test.ts`')
  assert.deepEqual(result.missingPaths, ['src/main/gone.test.ts'])
  assert.equal(result.checkedPaths, 1)
})

test('a line or range suffix names the file, not a different citation', () => {
  assert.deepEqual(resolve('`src/main/thing.test.ts:32`').missingPaths, [])
  assert.deepEqual(resolve('`src/main/thing.test.ts:32-40`').missingPaths, [])
  assert.deepEqual(resolve('`src/main/gone.test.ts:7`').missingPaths, ['src/main/gone.test.ts'])
})

test('a `**` glob cannot match a path that skipped the directory it stands for', () => {
  // `src/**/a.test.ts` must not match `src/xa.test.ts`, which is the shape a rotted glob hides behind.
  assert.deepEqual(resolve('`src/**/a.test.ts`').missingPaths, ['src/**/a.test.ts'])
  assert.deepEqual(resolve('`src/**/thing.test.ts`').missingPaths, [])
})
