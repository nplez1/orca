// The whole-file gate a resolution passes after every hunk in it is proven: `conflict-prove.mjs` has the
// tiers and the reasons this exists. Pure: the index facts (`moduleExists`, the three stages) are injected.
import { posix } from 'node:path'
import { parseSource, ts } from './ts-source.mjs'

/** The module and bound names of one import declaration; `type ` prefixes a type-only module. */
export function importFacts(node) {
  const clause = node.importClause
  const names = []
  if (clause?.name) {
    names.push(clause.name.text)
  }
  const bindings = clause?.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) {
    names.push(bindings.name.text)
  } else if (bindings) {
    names.push(...bindings.elements.map((element) => element.name.text))
  }
  const typeOnly = Boolean(clause?.isTypeOnly)
  return { module: `${typeOnly ? 'type ' : ''}${node.moduleSpecifier.text}`, names }
}

// `@/` and `@renderer/` are the tsconfig `paths` aliases; both point at the renderer source root.
const PATH_ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json'
]
// A `.js` specifier in TS ESM style names the `.ts` source.
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
// `vi.mock('../x')` and friends carry a module path exactly as an import does.
const PATH_CALLEE =
  /^(?:require|(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock))$/

const isPathSpecifier = (text) =>
  /^\.\.?(?:\/|$)/.test(text) || PATH_ALIASES.some(([alias]) => text.startsWith(alias))

/** Relative and aliased module specifiers in a parsed file: imports, re-exports, import(), require, vi.mock. */
export function modulePaths(sf) {
  const found = []
  const take = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      if (isPathSpecifier(node.text)) {
        found.push(node.text)
      }
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier)
    } else if (ts.isExternalModuleReference(node)) {
      take(node.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        PATH_CALLEE.test(node.expression.getText(sf)))
    ) {
      take(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...new Set(found)]
}

/** Whether `specifier`, written in the file at `from`, names a path `exists` accepts. */
export function resolvesInIndex(from, specifier, exists) {
  const bare = specifier.replace(/[?#].*$/, '')
  const alias = PATH_ALIASES.find(([prefix]) => bare.startsWith(prefix))
  const target = alias
    ? posix.normalize(alias[1] + bare.slice(alias[0].length))
    : posix.normalize(posix.join(posix.dirname(from), bare))
  if (target.startsWith('../') || target === '..' || posix.isAbsolute(target)) {
    return false
  }
  const stem = target.replace(/\/$/, '')
  const swapped = Object.entries(JS_TO_TS).flatMap(([js, tsExts]) =>
    stem.endsWith(js) ? tsExts.map((ext) => stem.slice(0, -js.length) + ext) : []
  )
  const candidates = [
    stem,
    ...swapped,
    ...RESOLVE_EXTENSIONS.map((ext) => stem + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${stem}/index${ext}`)
  ]
  return candidates.some((candidate) => exists(candidate))
}

/**
 * The resolved file's module paths that name nothing the merged index keeps, or a reason it cannot be
 * checked. With no `moduleExists` there is nothing to check against, so any path refuses: a caller that
 * forgets the index must not get unchecked writes.
 */
function unresolvedModules(path, parsed, moduleExists) {
  const specifiers = modulePaths(parsed.sf)
  if (typeof moduleExists !== 'function') {
    return specifiers.length === 0
      ? { reason: null, missing: [] }
      : { reason: 'no merged index to check its module paths against', missing: specifiers }
  }
  const missing = specifiers.filter((specifier) => !resolvesInIndex(path, specifier, moduleExists))
  return {
    reason:
      missing.length === 0
        ? null
        : `module path(s) that resolve to nothing the merge keeps: ${missing.join(', ')}`,
    missing
  }
}

const importedNames = (sf) =>
  new Set(
    sf.statements
      .filter((statement) => ts.isImportDeclaration(statement))
      .flatMap((statement) => importFacts(statement).names)
  )

/**
 * Names base imports, one index stage no longer imports, and the resolved file still does. Git's clean
 * merge is what produces these: upstream moves an import line out of the hunk while the fork deletes it
 * (and its use), so the union drops the hunk's copy and the moved copy survives, unused. The stages are
 * the real sides; the per-hunk reconstructions already carry git's clean merge and cannot show this.
 */
function droppedBindings(path, stages) {
  const parsed = ['base', 'ours', 'theirs'].map((side) => parseSource(path, stages?.[side] ?? null))
  if (parsed.some((side) => side === null || side.broken)) {
    return null
  }
  return parsed.map((side) => importedNames(side.sf))
}

/** Whole-file checks on a resolution every hunk proved; `null` when it may be written. */
export function resolvedFileGate(path, text, stages, moduleExists) {
  const parsed = parseSource(path, text)
  if (parsed === null) {
    return null
  }
  if (parsed.broken) {
    return { reason: 'the resolved file does not parse', missing: [] }
  }
  const modules = unresolvedModules(path, parsed, moduleExists)
  if (modules.reason !== null) {
    return modules
  }
  const sides = droppedBindings(path, stages)
  if (sides === null) {
    return { reason: 'no parsable index stages to check its imports against', missing: [] }
  }
  const [base, ours, theirs] = sides
  const dropped = [...importedNames(parsed.sf)].filter(
    (name) => base.has(name) && (!ours.has(name) || !theirs.has(name))
  )
  if (dropped.length > 0) {
    return {
      reason: `the resolved file still imports what one side removed: ${dropped.join(', ')}`,
      missing: []
    }
  }
  return null
}
