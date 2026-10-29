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

/**
 * Whether a specifier is one that names a repo path at all. A bare `electron` or `@scope/pkg` is a
 * package: nothing in this tree resolves it, and calling that dangling would be a false finding.
 */
export function isRepoSpecifier(specifier) {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    ALIASES.some(([prefix]) => specifier.startsWith(prefix))
  )
}

/**
 * References that name a repo path nobody has. `known` is the tree the references must resolve in —
 * HEAD after a merge, not the pre-merge tip — because the point is what the merged tree can still find.
 *
 * This is the check `rename-forecast` only ever ran *before* a merge: after it, an unresolved import was
 * silently null and nothing looked at it again. `pnpm tc` catches the TypeScript imports; it cannot see
 * `vi.mock('…')`, a path string, or a dynamic import in a `.mjs` file.
 */
export function danglingReferences({ references, known }) {
  const dangling = []
  for (const reference of references) {
    if (!isRepoSpecifier(reference.spec)) {
      continue
    }
    if (resolveSpecifier(reference.spec, reference.file, known) === null) {
      dangling.push(reference)
    }
  }
  return dangling
}

/** Fork-only means: present at HEAD under `src/`, absent from upstream's tree. Tests are not candidates. */
export function isSweepCandidate(path) {
  return (
    path.startsWith('src/') &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !/\.fixture\.|__fixtures__/.test(path)
  )
}
