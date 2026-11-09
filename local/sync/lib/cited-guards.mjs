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
// Pure: markdown, the tracked file list and the package scripts in, findings out.

const TEST_PATH =
  /^(?:src|config|tests|mobile|native|resources|local|docs|scripts|\.github)\/[\w./*+@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const PNPM_RUN = /`pnpm run ([a-z][\w:-]*)`/g
const NAMED_SCRIPT = /`([a-z][\w:-]*)` (?:npm )?script\b/g

/** `**` and `*` over a path, anchored: a citation is a whole path, not a fragment of one. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .split('\u0000')
    .join('.*')
  return new RegExp(`^${body}$`)
}

export function citedGuards(markdown) {
  const paths = new Set()
  const scripts = new Set()
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim()
    if (TEST_PATH.test(token)) {
      paths.add(token)
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
