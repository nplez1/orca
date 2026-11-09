// Fixture tests for the update-feed classification: which file in the tree is an anchor, which one
// names upstream's repo, and which one simply names no repo at all. No git, no filesystem:
//   node --test local/sync/lib/updater-feed.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFeedFiles } from './updater-feed.mjs'

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
