// The re-pointed-import check of the whole-file gate. Pure: the three sides' trees, blobs and renames are
// injected as `history` (`conflicts.mjs` reads them from git).
//
// An import union keeps whichever side re-pointed a binding at another module. That is right when the
// module merely moved: git's rename detection carries the other side's edits to the moved file. It is
// wrong when the side swapped providers while the other side changed the binding's declaration in the
// old one: the importer now reads a declaration that never saw that change. The 2026-11-15 merge wrote
// exactly that: upstream took `WorktreeStatus` from a shared rollup module while the fork had added
// `'setup'` to the renderer's `WorktreeStatus`, and the written file failed `tsc` four times.
import { resolvesInIndex } from './conflict-module-resolve.mjs'
import { parseSource, ts } from './ts-source.mjs'

export const SIDES = ['base', 'ours', 'theirs']

/**
 * `history` from three in-memory sides: `{ files: { base: Set, ours: Set, theirs: Set }, read(side,
 * path) -> string | null, renames: { ours: Map, theirs: Map } }` (base path -> that side's path).
 */
export function providerHistory({ files, read, renames }) {
  const texts = new Map()
  const blob = (side, path) => {
    const key = `${side}\u0000${path}`
    if (!texts.has(key)) {
      texts.set(key, read(side, path))
    }
    return texts.get(key)
  }
  const renamedTo = (side, basePath) =>
    side === 'base' ? basePath : (renames[side]?.get(basePath) ?? basePath)
  const basePathOf = (path) => {
    for (const side of ['ours', 'theirs']) {
      for (const [from, to] of renames[side] ?? []) {
        if (to === path) {
          return from
        }
      }
    }
    return path
  }
  /** The repo path `specifier` names from `from` in that side's own tree, or null. */
  const resolve = (side, from, specifier) => {
    let hit = null
    resolvesInIndex(
      from,
      specifier,
      (candidate) => {
        const found = files[side].has(candidate)
        hit ??= found ? candidate : null
        return found
      },
      'type'
    )
    return hit
  }
  return { blob, renamedTo, basePathOf, resolve }
}

/** Whitespace-normalised text of the top-level statements that declare or re-export `name`. */
export function declarationOf(path, text, name) {
  const parsed = text === null ? null : parseSource(path, text)
  if (parsed === null || parsed.broken) {
    return null
  }
  const { sf } = parsed
  const declares = (statement) => {
    if (statement.name?.text === name) {
      return true
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((item) => item.name.getText(sf) === name)
    }
    const clause = ts.isExportDeclaration(statement) ? statement.exportClause : null
    return Boolean(
      clause && ts.isNamedExports(clause) && clause.elements.some((item) => item.name.text === name)
    )
  }
  return sf.statements
    .filter(declares)
    .map((statement) => statement.getText(sf).replace(/\s+/g, ' '))
    .join('\n')
}

const importSources = (sf) => {
  const sources = new Map()
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      const names = [
        clause?.name?.text,
        ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map((item) => item.name.text)
          : [clause?.namedBindings?.name?.text])
      ].filter(Boolean)
      for (const name of names) {
        sources.set(name, statement.moduleSpecifier.text)
      }
    }
  }
  return sources
}

const isPath = (specifier) => /^(?:\.\.?(?:\/|$)|@\/|@renderer\/)/.test(specifier)

/**
 * Names the resolved file imports from another module than base did, where the side that did NOT pick
 * the new module changed the name's declaration in the old one and the new module is not where the old
 * one moved. `sides` holds each stage's parsed file; `null` history refuses any re-pointed name.
 */
export function swappedProviders({ path, resolvedSf, sides, history }) {
  const resolved = importSources(resolvedSf)
  const [base, ours, theirs] = SIDES.map((side) => importSources(sides[side]))
  const found = []
  for (const [name, specifier] of resolved) {
    const was = base.get(name)
    if (was === undefined || was === specifier || !isPath(was)) {
      continue
    }
    if (history === null) {
      found.push(`${name} (no history to check its old module against)`)
      continue
    }
    const taker =
      ours.get(name) === specifier ? 'ours' : theirs.get(name) === specifier ? 'theirs' : null
    if (taker !== null && (taker === 'ours' ? theirs : ours).get(name) === specifier) {
      continue
    }
    const basePath = history.basePathOf(path)
    const old = history.resolve('base', basePath, was)
    if (taker === null || old === null) {
      found.push(`${name} (its old module cannot be traced)`)
      continue
    }
    const other = taker === 'ours' ? 'theirs' : 'ours'
    const before = declarationOf(old, history.blob('base', old), name)
    const oldThere = history.renamedTo(other, old)
    if (before === declarationOf(oldThere, history.blob(other, oldThere), name)) {
      continue
    }
    const now = history.resolve(taker, history.renamedTo(taker, basePath), specifier)
    if (now !== history.renamedTo(taker, old)) {
      found.push(`${name} (now from ${now ?? specifier}; ${other} changed it in ${old})`)
    }
  }
  return found
}
