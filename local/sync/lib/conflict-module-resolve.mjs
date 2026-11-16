// How a module specifier resolves to a repo path: the tsconfig aliases by project, TypeScript's probing for
// a TS importer, Node's exact path for a JS one, and `@orca/` workspace packages through their exports.
import { posix } from 'node:path'

// The tsconfig `paths` aliases, by where the importer lives (mobile/ and docs/site/ map `@/` to their own
// src). An alias the importer's project does not map resolves to nothing, so it refuses.
const RENDERER_ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
const ALIAS_ROOTS = [
  [
    'mobile/',
    [
      ['@/', 'mobile/src/'],
      ['@orca/test-mobile/', 'mobile/src/'],
      ['@orca/test-host/', 'src/']
    ]
  ],
  ['docs/site/', [['@/', 'docs/site/src/']]],
  // config/tsconfig.web.json and tsconfig.e2e.json, the only projects that map them under src/ and tests/.
  ['src/renderer/', RENDERER_ALIASES],
  ['src/preload/', RENDERER_ALIASES],
  ['src/shared/', RENDERER_ALIASES],
  ['tests/', RENDERER_ALIASES]
]
export const ALIAS_PREFIXES = ['@/', '@renderer/']
// Workspace packages resolve through package.json `exports` (`orca-source`), never through a path.
export const WORKSPACE_PREFIX = '@orca/'
// Extension and `index` probing is TypeScript's resolution; a JS importer runs under Node, which needs
// the exact path. A value import never resolves to a `.d.ts`: that file has no runtime.
const TS_IMPORTER = /\.(?:[cm]?ts|tsx)$/
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
// A `.js` specifier in TS ESM style names the `.ts` source (or, for a type, its declaration).
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
const JS_TO_DTS = { '.js': '.d.ts', '.mjs': '.d.mts', '.cjs': '.d.cts' }
function aliasTarget(from, bare) {
  const roots = ALIAS_ROOTS.find(([under]) => from.startsWith(under))?.[1] ?? []
  const alias = roots.find(([prefix]) => bare.startsWith(prefix))
  return alias ? posix.normalize(alias[1] + bare.slice(alias[0].length)) : null
}

/**
 * Whether `specifier`, written in the file at `from`, names a path the index keeps. `index` is the
 * `exists(path)` predicate, or `{ exists, workspaceSource }` where `workspaceSource(specifier)` maps an
 * `@orca/` package export to its source path (or null).
 */
export function resolvesInIndex(from, specifier, index, kind = 'value') {
  const exists = typeof index === 'function' ? index : index.exists
  const bare = specifier.replace(/[?#].*$/, '')
  let target = aliasTarget(from, bare)
  if (target === null && bare.startsWith(WORKSPACE_PREFIX)) {
    const source = typeof index === 'function' ? null : index.workspaceSource?.(bare)
    return typeof source === 'string' && exists(source)
  }
  if (target === null && ALIAS_PREFIXES.some((alias) => bare.startsWith(alias))) {
    return false
  }
  target ??= posix.normalize(posix.join(posix.dirname(from), bare))
  if (target.startsWith('../') || target === '..' || posix.isAbsolute(target)) {
    return false
  }
  const stem = target.replace(/\/$/, '')
  if (kind === 'url' || !TS_IMPORTER.test(from)) {
    return exists(stem)
  }
  const extensions = kind === 'type' ? [...PROBE_EXTENSIONS, '.d.ts'] : PROBE_EXTENSIONS
  const swapped = Object.entries(JS_TO_TS).flatMap(([js, tsExts]) =>
    stem.endsWith(js)
      ? [
          ...tsExts.map((ext) => stem.slice(0, -js.length) + ext),
          ...(kind === 'type' && JS_TO_DTS[js] ? [stem.slice(0, -js.length) + JS_TO_DTS[js]] : [])
        ]
      : []
  )
  const candidates = [
    stem,
    ...swapped,
    ...extensions.map((ext) => stem + ext),
    ...extensions.map((ext) => `${stem}/index${ext}`)
  ]
  return candidates.some((candidate) => exists(candidate))
}
