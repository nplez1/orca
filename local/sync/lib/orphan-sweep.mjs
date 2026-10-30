// A fork-only module nothing imports is dead weight the sync cannot see: no conflict marker points at
// it, and the ledger named three of them dead on 2026-10-15 that were still there a year later. This
// turns the two facts git already has — which files upstream does not have, and what every file
// imports — into the list a human would otherwise re-derive with a careful grep.
import { posix } from 'node:path'
import { importSpecifiers } from '../../gate-flake-coupling.mjs'

// The repo's aliases, from tsconfig.json / config/tsconfig.web.json.
const ALIASES = [
  ['@/', 'src/renderer/src/'],
  ['@renderer/', 'src/renderer/src/']
]

const EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs'
]

// A `.js` specifier in a TypeScript file is the ESM spelling of the `.ts` module beside it, and the
// bundler resolves it that way. Without this every `import './x.js'` in a TS file reads as dangling.
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

/** The repo path a specifier names, or null when it is a package or cannot be resolved. */
export function resolveSpecifier(specifier, fromPath, known) {
  let base
  if (specifier.startsWith('.')) {
    base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  } else {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix))
    if (!alias) {
      return null
    }
    base = alias[1] + specifier.slice(alias[0].length)
  }
  const extension = posix.extname(base)
  const swapped = (JS_TO_TS[extension] ?? []).map((to) => base.slice(0, -extension.length) + to)
  for (const candidate of [...swapped, base]) {
    for (const suffix of EXTENSIONS) {
      if (known.has(candidate + suffix)) {
        return candidate + suffix
      }
    }
  }
  return null
}

/**
 * Fork-only files under `src/` that nothing in the tree imports.
 *
 * `sources` is every file that can carry a specifier (not only the fork-only ones — a config script or
 * a test importing a fork module keeps it alive), `forkOnly` the candidates, and `allowlist` the paths
 * loaded by name rather than by specifier, which no amount of scanning can see.
 */
export function orphanForkFiles({ sources, forkOnly, allowlist = [] }) {
  const known = new Set(sources.keys())
  const referenced = new Set()
  for (const [path, text] of sources) {
    for (const specifier of importSpecifiers(text)) {
      const target = resolveSpecifier(specifier, path, known)
      if (target) {
        referenced.add(target)
      }
    }
  }
  const allowed = new Set(allowlist)
  return [...forkOnly].filter((path) => !referenced.has(path) && !allowed.has(path)).sort()
}

/** Fork-only means: present at HEAD under `src/`, absent from upstream's tree. Tests are not candidates. */
export function isSweepCandidate(path) {
  return (
    path.startsWith('src/') &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !/\.fixture\.|__fixtures__/.test(path)
  )
}
