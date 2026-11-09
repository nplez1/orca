// Fixture tests for the pure pieces of the post-sync checks: which deleted paths count as a code
// module, what a deleted module's exported surface was, and how the update feed's files classify.
// No git, no filesystem:
//   node --test local/sync/lib/post-sync-checks.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFeedFiles, exportInventory, isDeletedCodeModule } from './post-sync-checks.mjs'

test('a deleted module is code that a caller could have imported', () => {
  assert.equal(
    isDeletedCodeModule('src/main/ipc/filesystem/filesystem-text-search-handler.ts'),
    true
  )
  assert.equal(isDeletedCodeModule('src/relay/quick-open-list-line-processor.ts'), true)
  assert.equal(isDeletedCodeModule('src/renderer/src/components/x/Y.tsx'), true)
  assert.equal(isDeletedCodeModule('local/sync/lib/post-sync-checks.mjs'), true)
})

test('deleted tests, declarations, fixtures and non-code are not modules to inventory', () => {
  assert.equal(isDeletedCodeModule('src/shared/node-markdown-document-discovery.test.ts'), false)
  assert.equal(isDeletedCodeModule('src/renderer/src/components/tab-bar/x.spec.tsx'), false)
  assert.equal(isDeletedCodeModule('src/shared/types.d.ts'), false)
  assert.equal(isDeletedCodeModule('src/shared/__fixtures__/workspace-path-memory.ts'), false)
  assert.equal(isDeletedCodeModule('src/shared/__mocks__/electron.ts'), false)
  assert.equal(isDeletedCodeModule('src/shared/thing.test.mjs'), false)
  assert.equal(isDeletedCodeModule('docs/reference/agent-status-store.md'), false)
  assert.equal(isDeletedCodeModule('config/patch.json'), false)
})

test('inventories every export shape the fork writes, and only the exported names', () => {
  const source = [
    "import { thing } from './thing'",
    '',
    '// export function fromAComment() {}',
    '/* export class FromABlockComment {} */',
    'const notExported = 1',
    'function alsoNotExported() {}',
    '',
    'export const MAX_RESULTS = 10',
    'export let mutable = 0',
    'export type SearchOptions = { rootPath: string }',
    'export interface Result { paths: string[] }',
    'export enum Mode { QuickOpen = 1 }',
    'export class Ranker {}',
    'export function registerThing(): void {}',
    'export async function handleThing(): Promise<void> {}',
    'export function* walk(): Generator<number> {}',
    'export { notExported as exportedAlias, thing }',
    "export type { Result as ResultAlias } from './result'",
    "export * from './everything'",
    'export default function namedDefault() {}'
  ].join('\n')
  assert.deepEqual(exportInventory(source), [
    { name: 'MAX_RESULTS', kind: 'const', anonymous: false },
    { name: 'Mode', kind: 'type', anonymous: false },
    { name: 'Ranker', kind: 'class', anonymous: false },
    { name: 'Result', kind: 'type', anonymous: false },
    { name: 'ResultAlias', kind: 're-export', anonymous: false },
    { name: 'SearchOptions', kind: 'type', anonymous: false },
    { name: 'exportedAlias', kind: 're-export', anonymous: false },
    { name: 'handleThing', kind: 'function', anonymous: false },
    { name: 'mutable', kind: 'const', anonymous: false },
    { name: 'namedDefault', kind: 'default', anonymous: false },
    { name: 'registerThing', kind: 'function', anonymous: false },
    { name: 'thing', kind: 're-export', anonymous: false },
    { name: 'walk', kind: 'function', anonymous: false }
  ])
})

test('a default export with no name has nothing to search for', () => {
  assert.deepEqual(exportInventory('export default {\n  a: 1\n}\n'), [
    { name: 'default', kind: 'default', anonymous: true }
  ])
})

test('a declared name is reported once, and keywords are never taken for a name', () => {
  const source = [
    'export const enum Level { A = 1 }',
    'export const Level = 1',
    'export declare const ambient: number',
    'export abstract class Base {}',
    'export type { Level }'
  ].join('\n')
  // `enum` and `declare` are never the declared name; three exports of `Level` are one name to search.
  assert.deepEqual(exportInventory(source), [
    { name: 'Base', kind: 'class', anonymous: false },
    { name: 'Level', kind: 'type', anonymous: false },
    { name: 'ambient', kind: 'const', anonymous: false }
  ])
})

test('a module with no exports inventories empty, not as the empty name', () => {
  assert.deepEqual(exportInventory("import x from 'y'\nconsole.log(x)\n"), [])
})

const ANCHOR = 'src/main/updater/releases/updater-prerelease-feed.ts'
const feed = (files) =>
  classifyFeedFiles({
    files: Object.keys(files),
    anchors: [ANCHOR],
    textOf: (file) => files[file] ?? null
  })

test('upstream\u2019s repo in a nested file fails, whatever depth upstream moved it to', () => {
  const result = feed({
    [ANCHOR]: "const REPO = 'nplez1/orca'\n",
    'src/main/updater/lifecycle/updater-setup.ts':
      "url: 'https://github.com/stablyai/orca/releases'\n"
  })
  assert.deepEqual(result.missing, [])
  assert.equal(result.upstream.length, 1)
  assert.match(result.upstream[0], /^src\/main\/updater\/lifecycle\/updater-setup\.ts: /)
})

test('a dev-channel repo is not upstream\u2019s main repo, so it stays green', () => {
  const result = feed({
    [ANCHOR]: "const REPO = 'nplez1/orca'\n",
    'src/main/updater/releases/updater-release-build-cache.test.ts':
      'releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/${tag}`,\n'
  })
  assert.deepEqual(result.upstream, [])
  assert.deepEqual(result.missing, [])
})

test('an anchor that names no repo and imports none fails', () => {
  const result = feed({
    [ANCHOR]: "import { x } from './elsewhere'\n"
  })
  assert.deepEqual(result.missing, [`${ANCHOR}: no reference to nplez1/orca`])
})

test('an anchor that reaches the slug through a checked constant is satisfied', () => {
  const result = feed({
    'src/main/updater-release-targets.ts': "export const RELEASES_REPO = 'nplez1/orca'\n",
    [ANCHOR]: "import { RELEASES_REPO } from '../../updater-release-targets'\n"
  })
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.silent, [])
})

test('a missing anchor is a failure, not a silent skip', () => {
  const result = feed({ 'src/main/updater/updater-events.ts': 'export {}\n' })
  assert.deepEqual(result.missing, [`${ANCHOR}: missing from the tree`])
  assert.deepEqual(result.absent, [ANCHOR])
})

test('a generic helper that names no repo is counted, not listed', () => {
  const result = feed({
    [ANCHOR]: "const REPO = 'nplez1/orca'\n",
    'src/main/updater/updater-events.ts': 'export const a = 1\n',
    'src/main/updater/releases/updater-changelog.ts': 'export const b = 2\n'
  })
  assert.deepEqual([...result.silent].sort(), [
    'src/main/updater/releases/updater-changelog.ts',
    'src/main/updater/updater-events.ts'
  ])
  assert.equal(result.scanned, 3)
})
