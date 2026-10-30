// Fixture tests for the post-merge dangling-reference sweep. Pure parts need no git; the last test
// builds a real conflict-free repo to exercise the git pipeline.
//   node --test local/sync/lib/dangling-references.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { danglingReferences } from './dangling-references.mjs'
import { fileSet } from './rename-forecast.mjs'

const reference = (file, spec, kind = 'import', line = 1) => ({ file, spec, kind, line })
const tree = (...files) => fileSet(files)

test('a module specifier is resolved; a package is not a repo path', () => {
  const set = tree('src/a/used.ts')
  const dangling = danglingReferences({
    set,
    references: [
      reference('src/a/b.ts', './used'),
      reference('src/a/b.ts', './gone'),
      reference('src/a/b.ts', 'electron'),
      reference('src/a/b.ts', '@scope/pkg'),
      reference('src/a/b.ts', '../a/used', 'mock')
    ]
  })
  assert.deepEqual(
    dangling.map((item) => item.spec),
    ['./gone']
  )
})

test('resolution uses the importer that exists at HEAD, not the pre-merge one', () => {
  const before = tree('src/a/target.ts', 'src/a/importer.ts')
  const after = tree('src/a/target.ts', 'src/moved/importer.ts')
  assert.deepEqual(
    danglingReferences({ set: before, references: [reference('src/a/importer.ts', './target')] }),
    []
  )
  assert.equal(
    danglingReferences({
      set: after,
      references: [reference('src/moved/importer.ts', './target')]
    }).length,
    1
  )
})

test('the bundler rules apply, so the shapes this repo writes are not false findings', () => {
  const set = tree(
    'src/cli/handlers/connector.ts',
    'src/renderer/src/i18n/locales/es.json',
    'src/shared/a.ts'
  )
  const dangling = danglingReferences({
    set,
    references: [
      // ESM spelling of the .ts module beside it
      reference('src/cli/handler-group-manifest.ts', './handlers/connector.js'),
      // a query suffix is not part of the path
      reference('src/renderer/src/i18n/i18n.ts', './locales/es.json?url'),
      // repo-relative, not relative to the importer
      reference('config/scripts/x.mjs', 'src/shared/a.ts', 'string'),
      reference('config/scripts/x.mjs', 'src/shared/missing.ts', 'string')
    ]
  })
  assert.deepEqual(
    dangling.map((item) => item.spec),
    ['src/shared/missing.ts']
  )
})

const {
  dir: repo,
  git,
  commit,
  remove
} = (await import('./temp-git-repo.mjs')).tempGitRepo('orca-dangling-references-')
after(remove)

commit('base', {
  'src/existing.ts': 'export const existing = 1\n',
  'src/target.ts': 'export const target = 1\n'
})
git('checkout', '-q', '-b', 'fork')
const tip = commit('fork work', {
  'src/existing.ts': [
    "import { target } from './target'",
    "vi.mock('./nowhere')",
    'export const existing = target',
    ''
  ].join('\n')
})
git('checkout', '-q', 'main')
// Upstream renames the very file the fork modified and moves its target: the merge lands the fork's
// lines at the new path, where both specifiers now point at nothing.
git('mv', 'src/existing.ts', 'src/renamed.ts')
commit('upstream renames the file the fork touched', {
  'src/elsewhere/target.ts': 'export const target = 1\n'
})
git('rm', '-q', 'src/target.ts')
const newBase = commit('upstream moves the target')
git('update-ref', 'refs/remotes/upstream/main', newBase)
git('checkout', '-q', 'fork')
git('merge', '-q', '--no-edit', 'main')

git('rm', '-q', 'src/elsewhere/target.ts')
commit('drop the target')

process.chdir(repo)
const { danglingForkReferences } = await import('./dangling-references.mjs')

test('the git sweep follows upstream renames and fails on specifiers nothing has', () => {
  const outcome = danglingForkReferences(tip, 'fixture')
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /2 fork-added module specifier\(s\) name no file at HEAD/)
  // Both findings are reported at the RENAMED path: the old path looks deleted, and skipping it would
  // skip exactly the file whose relative specifiers the rename broke.
  assert.ok(
    outcome.details.some(
      (line) => line.includes('src/renamed.ts:') && line.includes("mock './nowhere'")
    )
  )
  assert.ok(
    outcome.details.some(
      (line) => line.includes('src/renamed.ts:') && line.includes("import './target'")
    )
  )
  assert.ok(outcome.details.some((line) => /\d+ upstream rename\(s\) followed/.test(line)))
})

test('a tip that belongs to another sync is refused rather than scanned', () => {
  const outcome = danglingForkReferences(tip, 'fixture', 'the state file names commit deadbeef00')
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /does not belong to this sync/)
})

test('no tip is unavailable, and never a pass', () => {
  const outcome = danglingForkReferences(null, null)
  assert.equal(outcome.status, 'unavailable')
})
