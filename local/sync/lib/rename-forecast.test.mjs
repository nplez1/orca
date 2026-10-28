// Fixture tests for the pre-merge rename forecast. No git, no filesystem:
//   node --test local/sync/lib/rename-forecast.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addedLines,
  fileSet,
  forecastRenames,
  parseNameStatus,
  referencesIn,
  resolveRef
} from './rename-forecast.mjs'

test('name-status keeps renames and deletions, and skips modifications and copies', () => {
  const { renames, deletions } = parseNameStatus(
    [
      'R095',
      'src/a.ts',
      'src/x/a.ts',
      'M',
      'src/m.ts',
      'C100',
      'src/c.ts',
      'src/d.ts',
      'D',
      'src/gone.ts',
      ''
    ].join('\0')
  )
  assert.deepEqual([...renames], [['src/a.ts', 'src/x/a.ts']])
  assert.deepEqual([...deletions], ['src/gone.ts'])
})

test('added lines come from the new-file side of every -U0 hunk', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@',
    '+x',
    '+y',
    '@@ -9 +11 @@',
    '-old',
    '+new',
    '@@ -20,2 +22,0 @@',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '+++ "b/src/sp ace.ts"',
    '@@ -0,0 +1 @@'
  ].join('\n')
  const lines = addedLines(diff)
  assert.deepEqual([...lines.get('src/a.ts')], [4, 5, 11])
  assert.deepEqual([...lines.get('src/sp ace.ts')], [1])
  assert.equal(lines.has('src/gone.ts'), false)
})

test('references are imports, mocks and path strings on the added lines only', () => {
  const text = [
    "import { a } from './a'",
    "export { b } from './b'",
    "const c = await import('./c')",
    "const d = require('./d')",
    "vi.mock('./e', () => ({}))",
    "const f = 'src/main/f.ts'",
    "const g = 'not a path'",
    "import { h } from './untouched'",
    "type I = import('./i').I"
  ].join('\n')
  const refs = referencesIn('src/x.ts', text, new Set([1, 2, 3, 4, 5, 6, 7, 9]))
  assert.deepEqual(
    refs.map((ref) => [ref.spec, ref.kind]),
    [
      ['./a', 'import'],
      ['./b', 'import'],
      ['./c', 'import'],
      ['./d', 'import'],
      ['./e', 'mock'],
      ['src/main/f.ts', 'string'],
      ['./i', 'import']
    ]
  )
})

test('resolution follows the bundler: extensions, index files, .js to .ts, the @/ alias', () => {
  const set = fileSet(['src/a.ts', 'src/b/index.tsx', 'src/c.ts', 'src/renderer/src/d.ts'])
  assert.equal(resolveRef('src/x.ts', './a', 'import', set).path, 'src/a.ts')
  assert.equal(resolveRef('src/x.ts', './b', 'import', set).path, 'src/b/index.tsx')
  assert.equal(resolveRef('src/x.ts', './c.js', 'import', set).path, 'src/c.ts')
  assert.equal(resolveRef('src/x.ts', '@/d', 'import', set).path, 'src/renderer/src/d.ts')
  assert.deepEqual(resolveRef('src/x.ts', 'src/b', 'string', set), { path: 'src/b', dir: true })
  assert.equal(resolveRef('src/x.ts', 'react', 'import', set), null)
})

const world = ({ renames = [], deletions = [], oldBase, forkAdded = [], newBase }) => ({
  renames: new Map(renames),
  deletions: new Set(deletions),
  oldBaseFiles: oldBase,
  tipFiles: [...oldBase, ...forkAdded],
  newBaseFiles: newBase
})

test('a fork import of a file upstream renamed is reported with the specifier it needs', () => {
  const report = forecastRenames({
    ...world({
      renames: [['src/shared/jira-types.ts', 'src/shared/jira/jira-types.ts']],
      oldBase: ['src/shared/jira-types.ts'],
      forkAdded: ['src/main/fork.ts'],
      newBase: ['src/shared/jira/jira-types.ts']
    }),
    references: [
      { file: 'src/main/fork.ts', spec: '../shared/jira-types', kind: 'import', line: 3 }
    ]
  })
  assert.deepEqual(report.missingRefs, [
    {
      from: 'src/shared/jira-types.ts',
      to: 'src/shared/jira/jira-types.ts',
      kinds: ['import'],
      referencedBy: ['src/main/fork.ts:3'],
      suggested: ['../shared/jira/jira-types']
    }
  ])
})

test('a deleted target is reported with no destination', () => {
  const report = forecastRenames({
    ...world({
      deletions: ['src/gone.ts'],
      oldBase: ['src/gone.ts', 'src/x.test.ts'],
      newBase: ['src/x.test.ts']
    }),
    references: [{ file: 'src/x.test.ts', spec: './gone', kind: 'mock', line: 7 }]
  })
  assert.equal(report.missingRefs[0].to, null)
  assert.deepEqual(report.missingRefs[0].referencedBy, ['src/x.test.ts:7'])
})

test('a directory that moved with its importer inside it is not a finding', () => {
  const report = forecastRenames({
    ...world({
      renames: [
        ['src/ipc/watcher-a.ts', 'src/ipc/watchers/watcher-a.ts'],
        ['src/ipc/watcher-b.ts', 'src/ipc/watchers/watcher-b.ts']
      ],
      oldBase: ['src/ipc/watcher-a.ts', 'src/ipc/watcher-b.ts'],
      newBase: ['src/ipc/watchers/watcher-a.ts', 'src/ipc/watchers/watcher-b.ts']
    }),
    references: [{ file: 'src/ipc/watcher-a.ts', spec: './watcher-b', kind: 'import', line: 1 }]
  })
  assert.deepEqual(report.missingRefs, [])
})

test('an importer moved away from a fork-only target is a finding, with the new relative path', () => {
  const report = forecastRenames({
    ...world({
      renames: [['src/ipc/watcher-a.ts', 'src/ipc/watchers/watcher-a.ts']],
      oldBase: ['src/ipc/watcher-a.ts'],
      forkAdded: ['src/ipc/fork-teardown.ts'],
      newBase: ['src/ipc/watchers/watcher-a.ts']
    }),
    references: [{ file: 'src/ipc/watcher-a.ts', spec: './fork-teardown', kind: 'import', line: 9 }]
  })
  assert.equal(report.missingRefs[0].from, 'src/ipc/fork-teardown.ts')
  assert.equal(report.missingRefs[0].to, 'src/ipc/fork-teardown.ts')
  assert.deepEqual(report.missingRefs[0].suggested, ['../fork-teardown'])
})

test('a string path to a directory that moved wholesale names its new home', () => {
  const report = forecastRenames({
    ...world({
      renames: [
        ['src/shared/jira/a.ts', 'src/shared/tracker/jira/a.ts'],
        ['src/shared/jira/b.ts', 'src/shared/tracker/jira/b.ts']
      ],
      oldBase: ['src/shared/jira/a.ts', 'src/shared/jira/b.ts', 'config/x.mjs'],
      newBase: ['src/shared/tracker/jira/a.ts', 'src/shared/tracker/jira/b.ts', 'config/x.mjs']
    }),
    references: [{ file: 'config/x.mjs', spec: 'src/shared/jira', kind: 'string', line: 2 }]
  })
  assert.equal(report.missingRefs[0].from, 'src/shared/jira')
  assert.equal(report.missingRefs[0].to, 'src/shared/tracker/jira')
})

test('a reference that still resolves after the merge is not reported', () => {
  const report = forecastRenames({
    ...world({ oldBase: ['src/a.ts', 'src/b.ts'], newBase: ['src/a.ts', 'src/b.ts'] }),
    references: [
      { file: 'src/a.ts', spec: './b', kind: 'import', line: 1 },
      { file: 'src/a.ts', spec: 'react', kind: 'import', line: 2 }
    ]
  })
  assert.deepEqual(report.missingRefs, [])
  assert.equal(report.counts.scannedReferences, 2)
})

test('a directory scattered across several homes, or renamed file by file, has no destination', () => {
  const report = forecastRenames({
    ...world({
      renames: [
        ['src/old/a.ts', 'src/one/a.ts'],
        ['src/old/b.ts', 'src/two/b.ts'],
        ['src/solo/a.ts', 'src/new/renamed.ts']
      ],
      oldBase: ['src/old/a.ts', 'src/old/b.ts', 'src/solo/a.ts', 'config/x.mjs'],
      newBase: ['src/one/a.ts', 'src/two/b.ts', 'src/new/renamed.ts', 'config/x.mjs']
    }),
    references: [
      { file: 'config/x.mjs', spec: 'src/old', kind: 'string', line: 1 },
      { file: 'config/x.mjs', spec: 'src/solo', kind: 'string', line: 2 }
    ]
  })
  assert.deepEqual(
    report.missingRefs.map((ref) => [ref.from, ref.to]),
    [
      ['src/old', null],
      ['src/solo', null]
    ]
  )
})
