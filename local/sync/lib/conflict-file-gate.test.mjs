// Fixture tests for the whole-file gate a fully proven resolution must pass. No git, no filesystem:
//   node --test local/sync/lib/conflict-file-gate.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { modulePaths, resolvesInIndex } from './conflict-file-gate.mjs'
import { indexModuleOracle, treeModuleOracle } from './conflict-index.mjs'
import { proveFile } from './conflict-prove.mjs'
import { everyModule, file, historyOf, hunk, proveWithIndex } from './conflict-test-fixtures.mjs'
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
  // `E` was re-pointed at a module the fork never touched: the history says so.
  const env = { 'src/cli/shared/env.ts': 'export const E = 1\n' }
  const rebased = proveWithIndex(path, merged('../../../shared/app-directory-names'), {
    exists: (at) => index.has(at),
    history: historyOf({ base: env, ours: env, theirs: { 'src/shared/remote/env.ts': '' } })
  })
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

test('module paths are read from every import form, with how each one resolves', () => {
  const { sf } = parseSource(
    'src/renderer/src/a.test.ts',
    [
      "import { a } from './a.js'",
      "import type { T } from './t'",
      "export { b } from '../b'",
      "export * from './star'",
      "import pkg from 'react'",
      "import eq = require('./eq')",
      "vi.mock('@/store/c', () => ({}))",
      "vitest.mock('@renderer/store/v')",
      "const d = await import('./d')",
      "const r = require('./r')",
      "const where = require.resolve('./w')",
      "const icon = new URL('./icon.svg', import.meta.url)",
      "import raw from './shader.glsl?raw'",
      "import { run } from '@orca/process-host'",
      "type E = typeof import('./e')"
    ].join('\n')
  )
  assert.deepEqual(
    modulePaths(sf).map(({ specifier, kind }) => `${kind} ${specifier}`),
    [
      'value ./a.js',
      'type ./t',
      'value ../b',
      'value ./star',
      'value ./eq',
      'value @/store/c',
      'value @renderer/store/v',
      'value ./d',
      'value ./r',
      'value ./w',
      'url ./icon.svg',
      'value ./shader.glsl?raw',
      'value @orca/process-host',
      'type ./e'
    ]
  )
})

test('a TS importer probes like the compiler; a JS importer and a URL need the exact path', () => {
  const index = new Set([
    'src/renderer/src/a.ts',
    'src/renderer/b/index.tsx',
    'src/renderer/src/store/c.ts',
    'src/renderer/src/types.d.ts',
    'src/renderer/src/shader.glsl',
    'local/x.mts',
    'local/y.mjs',
    'mobile/src/theme.ts',
    'docs/site/src/page.tsx'
  ])
  const exists = (at) => index.has(at)
  const from = 'src/renderer/src/a.test.ts'
  assert.equal(resolvesInIndex(from, './a.js', exists), true)
  assert.equal(resolvesInIndex(from, '../b', exists), true)
  assert.equal(resolvesInIndex(from, './shader.glsl?raw', exists), true)
  assert.equal(resolvesInIndex(from, './d', exists), false)
  assert.equal(resolvesInIndex('src/a.ts', '../../outside', exists), false)
  // A value import has no runtime in a `.d.ts`; a type import may name one.
  assert.equal(resolvesInIndex(from, './types', exists, 'value'), false)
  assert.equal(resolvesInIndex(from, './types', exists, 'type'), true)
  // Node resolves a .mjs importer's `./x.mjs` exactly: x.mts is not it, though a .ts importer's would be.
  assert.equal(resolvesInIndex('local/z.mjs', './x.mjs', exists), false)
  assert.equal(resolvesInIndex('local/z.mts', './x.mjs', exists), true)
  assert.equal(resolvesInIndex('local/z.mjs', './y.mjs', exists), true)
  assert.equal(resolvesInIndex('local/z.mjs', './y', exists), false)
  assert.equal(resolvesInIndex(from, './a', exists, 'url'), false)
})

test('an alias resolves from the project the importer is in, and refuses where none maps it', () => {
  const index = new Set([
    'src/renderer/src/store/c.ts',
    'mobile/src/theme.ts',
    'docs/site/src/page.tsx'
  ])
  const exists = (at) => index.has(at)
  assert.equal(resolvesInIndex('src/renderer/src/x.ts', '@/store/c', exists), true)
  assert.equal(resolvesInIndex('tests/e2e/x.ts', '@renderer/store/c', exists), true)
  assert.equal(resolvesInIndex('mobile/src/app.ts', '@/theme', exists), true)
  assert.equal(resolvesInIndex('mobile/src/app.ts', '@/store/c', exists), false)
  assert.equal(resolvesInIndex('docs/site/app/x.tsx', '@/page', exists), true)
  // The main-process project maps no `@/`.
  assert.equal(resolvesInIndex('src/main/x.ts', '@/store/c', exists), false)
})

test('a workspace package resolves through its source export, and nothing else', () => {
  const index = {
    exists: (at) => at === 'src/packages/process-host/src/run-process.ts',
    workspaceSource: (specifier) =>
      specifier === '@orca/process-host'
        ? 'src/packages/process-host/src/run-process.ts'
        : specifier === '@orca/process-host/gone'
          ? 'src/packages/process-host/src/gone.ts'
          : null
  }
  assert.equal(resolvesInIndex('src/main/x.ts', '@orca/process-host', index), true)
  assert.equal(resolvesInIndex('src/main/x.ts', '@orca/process-host/gone', index), false)
  assert.equal(resolvesInIndex('src/main/x.ts', '@orca/unknown', index), false)
  assert.equal(resolvesInIndex('src/main/x.ts', '@orca/process-host', index.exists), false)
})

test('a proven file is not written while it uses a binding one side stopped importing', () => {
  // The fork deleted `x`'s import; upstream re-pointed `y` and added a use of `x` that merged cleanly.
  const merged = file(
    hunk({
      ours: ["import { y } from './y'"],
      base: ["import { x } from './x'", "import { y } from './y'"],
      theirs: ["import { x } from './x'", "import { y } from './moved/y'"]
    }),
    'export const z = x + y'
  )
  const stages = {
    base: file("import { x } from './x'", "import { y } from './y'", 'export const z = y'),
    ours: file("import { y } from './y'", 'export const z = y'),
    theirs: file(
      "import { x } from './x'",
      "import { y } from './moved/y'",
      'export const z = x + y'
    )
  }
  const result = proveWithIndex('src/a.ts', merged, everyModule, stages)
  assert.equal(result.provenHunks, 1)
  assert.equal(result.fullyProven, false)
  assert.match(result.reason, /uses what it no longer imports: x$/)
  // A member or a local declaration of the same name is not a use of the import.
  const y = { 'src/y.ts': 'export const y = 1\n' }
  const local = proveWithIndex(
    'src/a.ts',
    merged.replace('export const z = x + y', 'const x = 1\nexport const z = { x: y.x, w: x }'),
    { exists: everyModule, history: historyOf({ base: y, ours: y, theirs: {} }) },
    stages
  )
  assert.equal(local.fullyProven, true)
})

test('an inner parameter of the same name does not stand in for a dropped module-scope import', () => {
  // Upstream dropped `import path`; the fork's clean-merged module-scope code still calls path.join, and
  // an unrelated function takes a `path` parameter. Only a module-scope declaration binds the use.
  const merged = file(
    hunk({
      ours: ["import path from 'node:path'", "import { f } from './f'"],
      base: ["import path from 'node:path'"],
      theirs: ["import { g } from './g'"]
    }),
    "export const root = path.join('a', 'b')",
    'export function g2(path: string) { return path }',
    'export type Pick<T> = T extends infer K ? K : never'
  )
  const stages = {
    base: file("import path from 'node:path'", "export const root = path.join('a', 'b')"),
    ours: file(
      "import path from 'node:path'",
      "import { f } from './f'",
      "export const root = path.join('a', 'b')"
    ),
    theirs: file("import { g } from './g'", 'export function g2(path: string) { return path }')
  }
  const result = proveWithIndex('src/a.ts', merged, everyModule, stages)
  assert.equal(result.provenHunks, 1)
  assert.match(result.reason, /uses what it no longer imports: path$/)
})

test('a proven file is not written while it re-exports what one side removed', () => {
  // Upstream moved the re-export to the top and re-pointed it; the fork deleted it. Both merge cleanly.
  const merged = file(
    "export { m } from './new/m'",
    hunk({
      ours: ["import { k } from './k'", "import { f } from './f'"],
      base: ["import { k } from './k'"],
      theirs: ["import { k } from './k'", "import { u } from './u'"]
    })
  )
  const stages = {
    base: file("import { k } from './k'", "export { m } from './m'"),
    ours: file("import { k } from './k'", "import { f } from './f'"),
    theirs: file(
      "export { m } from './new/m'",
      "import { k } from './k'",
      "import { u } from './u'"
    )
  }
  const result = proveWithIndex('src/a.ts', merged, everyModule, stages)
  assert.equal(result.provenHunks, 1)
  assert.match(result.reason, /still imports what one side removed: export m$/)
})

test('the index keeps a stage-0 path or a both-sides conflict, never a modify/delete', () => {
  const record = (mode, stage, path) => `${mode} ${'a'.repeat(40)} ${stage}\t${path}`
  const { exists } = indexModuleOracle(
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

test('a --merge-tree run keeps the result tree less every conflict that is not both-modified', () => {
  const { exists } = treeModuleOracle(['src/a.ts', 'src/ud.ts', 'src/uu.ts', ''].join('\u0000'), [
    { path: 'src/ud.ts', status: 'UD' },
    { path: 'src/uu.ts', status: 'UU' }
  ])
  assert.deepEqual(['src/a.ts', 'src/ud.ts', 'src/uu.ts', 'src/b.ts'].map(exists), [
    true,
    false,
    true,
    false
  ])
})
