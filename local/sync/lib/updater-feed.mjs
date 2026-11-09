// The update feed check: the anchors that hold the fork's release repo, and the whole tree upstream
// keeps moving them into.
//
// Why its own module: the 2026-11-08 sync re-homed the updater into `lifecycle/`, `releases/`,
// `mac-install/` and three more levels, and the old check globbed one directory, so it scanned six
// files and passed. A scan that cannot see the tree it is scanning is the failure this exists for.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FORK_SLUG } from './post-sync-checks.mjs'
import { STATUS, gitText, repoRoot, splitNul } from './run.mjs'

// The upstream main repo. Not a substring test: `stablyai/orca-hourly` and its daily and adhoc
// siblings are different repositories, kept on purpose in `release-channel.ts` because the fork
// routes every channel to its own repo rather than deleting the dev-channel names.
export const UPSTREAM_SLUG = /stablyai\/orca(?![\w-])/
// The tree upstream keeps reorganising: `updater/lifecycle/`, `updater/releases/` and four more
// levels appeared in the 2026-11-08 sync, which is how a top-level-only glob stopped finding them.
export const FEED_TREE = 'src/main/updater'
// The update feed must keep naming the fork: without it an update check resolves upstream releases
// and a fork install "upgrades" to a build carrying none of the fork's patches. These are the files
// that hold or derive the repo, so a loss here is a lost feed; a generic helper naming no repo is not.
export const FEED_FILES = [
  'src/main/updater-release-targets.ts',
  'src/main/updater/lifecycle/updater-setup.ts',
  'src/main/updater/releases/updater-prerelease-feed.ts',
  'src/main/updater/releases/updater-release-readiness.ts',
  'src/shared/release-channel.ts'
]

/** True when one of `file`'s relative imports resolves to a file that carries the slug. */
function importsHolder(file, text, holders) {
  const dir = path.posix.dirname(file)
  for (const match of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const specifier = match[1]
    for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`]) {
      if (holders.has(path.posix.normalize(path.posix.join(dir, candidate)))) {
        return true
      }
    }
  }
  return false
}

/**
 * The feed classification, as a pure function of the file list and their text (`null` = absent).
 *
 * Two findings fail: an anchor that no longer names the fork, and any file in the tree that names
 * upstream's repo. A generic helper that names no repo at all is normal — most of them never touch
 * a release URL — so it is counted rather than listed line by line.
 */
export function classifyFeedFiles({ files, anchors, textOf }) {
  const absent = []
  const upstream = []
  const missing = []
  const silent = []
  const holders = new Set()
  const texts = new Map()
  for (const file of files) {
    const text = textOf(file)
    texts.set(file, text)
    if (text === null) {
      absent.push(file)
      continue
    }
    if (text.includes(FORK_SLUG)) {
      holders.add(file)
    }
    for (const line of text.split('\n')) {
      if (UPSTREAM_SLUG.test(line)) {
        upstream.push(`${file}: ${line.trim()}`)
      }
    }
  }
  // The slug may be held once and derived everywhere else, so a file that imports a file which does
  // carry it is satisfied through that constant — the alternative is a copy of the literal that can
  // drift, which is what this check exists to prevent.
  for (const file of anchors) {
    const text = texts.get(file) ?? null
    if (text === null) {
      missing.push(`${file}: missing from the tree`)
      if (!absent.includes(file)) {
        absent.push(file)
      }
    } else if (!holders.has(file) && !importsHolder(file, text, holders)) {
      missing.push(`${file}: no reference to ${FORK_SLUG}`)
    }
  }
  for (const file of files) {
    if (!anchors.includes(file) && !holders.has(file)) {
      silent.push(file)
    }
  }
  return { absent, upstream, missing, silent, scanned: files.length }
}

/** Every tracked file under the updater tree, plus the anchors that live outside it. */
function feedFiles() {
  const listing = gitText(['ls-files', '-z', '--', FEED_TREE])
  const tracked = listing === null ? [] : splitNul(listing)
  if (tracked.length === 0) {
    return null
  }
  return [...new Set([...FEED_FILES, ...tracked])].sort()
}

export function updaterFeed() {
  const files = feedFiles()
  if (files === null) {
    return {
      status: STATUS.failed,
      summary: `${FEED_TREE}/ has no tracked files, so the updater cannot be scanned`,
      details: []
    }
  }
  const result = classifyFeedFiles({
    files,
    anchors: FEED_FILES,
    textOf: (file) => {
      try {
        return readFileSync(path.join(repoRoot(), file), 'utf8')
      } catch {
        return null
      }
    }
  })
  const helpers = files.filter((file) => path.posix.basename(file).startsWith('updater-'))
  const details = [
    `${result.scanned} file(s) scanned: ${FEED_TREE}/ plus ${FEED_FILES.length} anchor(s), ${helpers.length} updater-*.ts helper(s)`,
    ...(result.silent.length === 0
      ? []
      : [`${result.silent.length} file(s) name no repository, expected for a generic helper`]),
    // No `updater-*.ts` at any depth means upstream moved the updater again, which is the state that
    // made a top-level-only glob scan nothing and report a pass.
    ...(helpers.length === 0
      ? [`${FEED_TREE}/ has no updater-*.ts at any depth: upstream may have moved the updater`]
      : []),
    ...result.upstream.map((line) => `  ! ${line}`),
    ...result.missing.map((line) => `  ! ${line}`)
  ]
  if (result.upstream.length > 0) {
    return {
      status: STATUS.failed,
      summary: `${result.upstream.length} line(s) under ${FEED_TREE}/ name upstream's repository`,
      details
    }
  }
  return {
    status: result.missing.length > 0 ? STATUS.failed : STATUS.passed,
    summary:
      result.missing.length > 0
        ? `${result.missing.length} feed anchor(s) lost the fork reference`
        : `feed override still points at the fork (${result.scanned} file(s) scanned)`,
    details
  }
}
