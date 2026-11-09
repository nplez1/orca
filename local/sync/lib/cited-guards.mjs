// The guards LOCAL-PATCHES.md cites, resolved against the tree.
//
// Why: a patch ledger whose citations point at files that no longer exist is a ledger that cannot be
// checked. The 2026-11-08 sync moved 21 cited tests into upstream's owner-scoped directories and
// retired 16 more, and the `rebuild:mac:relaunch-installed` script was lost in a merge — none of which
// anything noticed, because nothing read the citations. This reads them.
//
// Two shapes are checked, because they are the two the ledger actually uses:
//
//   `src/main/thing.test.ts`        a repo-relative test path, or a glob over them
//   `pnpm run <name>`               an explicit package script
//   `<name>` script                 the same, named in prose
//
// A bare `a:b` token is NOT a script name: the ledger is full of `node:sqlite`, `ssh:host-b` and
// `orca://`, and guessing at them would make the row noise. A bare `pnpm test` is not checked either,
// because `install`, `exec` and the rest are pnpm's own verbs rather than the repo's.
//
// The pure part is `extractCitedGuards` + `missingCitedGuards`; `citedGuards()` is the post-sync row, which
// reads the ledger, the tracked file list and `package.json`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { STATUS, gitText, repoRoot, splitNul } from './run.mjs'

const TEST_PATH =
  /^(?:src|config|tests|mobile|native|resources|local|docs|scripts|\.github)\/[\w./*+@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/
// `file.test.ts:32` names the same file; the line is a reading aid, and an anchored test that ignored
// it would skip every citation written that way.
const LINE_SUFFIX = /:\d+(?:-\d+)?$/
// Trailing sentence punctuation, never the dot of an extension.
const TRAILING = /[),;]+$/
const PNPM_RUN = /`pnpm run ([a-z][\w:-]*)`/g
const NAMED_SCRIPT = /`([a-z][\w:-]*)` (?:npm )?script\b/g

/**
 * `**` and `*` over a path, anchored: a citation is a whole path, not a fragment of one. `**\/` maps
 * to `(?:.*\/)?` rather than `.*`, so `src/**\/a.test.ts` cannot match `src/xa.test.ts` — a rotted
 * glob that reads as present is the failure this row exists to catch.
 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .split('\u0000')
    .join('(?:.*/)?')
    .split('\u0001')
    .join('.*')
  return new RegExp(`^${body}$`)
}

export function extractCitedGuards(markdown) {
  const paths = new Set()
  const scripts = new Set()
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    // Every word, so a path inside a cited command (`pnpm test src/a/b.test.ts`) is read too: that is
    // the shape the ledger uses for a guard it runs rather than merely names.
    for (const word of match[1].trim().split(/\s+/)) {
      const candidate = word.replace(LINE_SUFFIX, '').replace(TRAILING, '').replace(/^\.\//, '')
      if (TEST_PATH.test(candidate)) {
        paths.add(candidate)
      }
    }
  }
  for (const pattern of [PNPM_RUN, NAMED_SCRIPT]) {
    for (const match of markdown.matchAll(pattern)) {
      scripts.add(match[1])
    }
  }
  return { paths: [...paths].sort(), scripts: [...scripts].sort() }
}

/**
 * Which citations resolve. `tracked` is the repo's file list; a glob resolves when at least one
 * tracked path matches it, because a glob that matches nothing is exactly the citation that rotted.
 */
export function missingCitedGuards({ cited, tracked, scripts }) {
  const files = new Set(tracked)
  const known = new Set(Object.keys(scripts ?? {}))
  const missingPaths = []
  const missingScripts = []
  for (const citedPath of cited.paths) {
    if (citedPath.includes('*')) {
      const pattern = globToRegExp(citedPath)
      if (![...files].some((file) => pattern.test(file))) {
        missingPaths.push(citedPath)
      }
      continue
    }
    if (!files.has(citedPath)) {
      missingPaths.push(citedPath)
    }
  }
  for (const name of cited.scripts) {
    if (!known.has(name)) {
      missingScripts.push(name)
    }
  }
  return {
    missingPaths,
    missingScripts,
    checkedPaths: cited.paths.length,
    checkedScripts: cited.scripts.length
  }
}

// ---- cited guards ----------------------------------------------------------------------------

/**
 * Every test path and package script LOCAL-PATCHES.md cites, resolved against the tree.
 *
 * The ledger is the only record of why each fork patch exists, and its citations are how a reader
 * checks one. Nothing read them, so the 2026-11-08 sync moved 14 cited tests into upstream's
 * owner-scoped directories, retired 16 more, and dropped the `rebuild:mac:relaunch-installed` script
 * without anything going red. This is the row that reads them.
 */
export function citedGuards() {
  const file = path.join(repoRoot(), 'LOCAL-PATCHES.md')
  let markdown = null
  try {
    markdown = readFileSync(file, 'utf8')
  } catch {
    return {
      status: STATUS.failed,
      summary: 'LOCAL-PATCHES.md could not be read',
      details: [file]
    }
  }
  const tracked = gitText(['ls-files', '-z'])
  if (tracked === null) {
    return {
      status: STATUS.failed,
      summary: 'git ls-files failed, so no citation can be resolved',
      details: []
    }
  }
  let scripts = null
  try {
    scripts = JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')).scripts
  } catch {
    return {
      status: STATUS.failed,
      summary: 'package.json could not be read, so no script citation can be resolved',
      details: []
    }
  }
  const cited = extractCitedGuards(markdown)
  const result = missingCitedGuards({
    cited,
    tracked: splitNul(tracked),
    scripts: scripts ?? {}
  })
  const details = [
    `${result.checkedPaths} cited test path(s) and ${result.checkedScripts} cited script(s) resolved`,
    ...result.missingPaths.map((file) => `  ! ${file} — cited, but no tracked file matches`),
    ...result.missingScripts.map(
      (name) => `  ! ${name} — cited, but package.json has no such script`
    )
  ]
  const missing = result.missingPaths.length + result.missingScripts.length
  return {
    status: missing === 0 ? STATUS.passed : STATUS.failed,
    summary:
      missing === 0
        ? `every guard LOCAL-PATCHES.md cites still exists (${result.checkedPaths} path(s), ${result.checkedScripts} script(s))`
        : `${missing} guard(s) LOCAL-PATCHES.md cites no longer exist`,
    details
  }
}
