// The re-pointed-import check of the whole-file gate. Pure: the three sides' trees, blobs, renames and
// the merge's own pairing of a moved file are injected as `history` (`conflicts.mjs` reads them from git).
//
// An import union keeps whichever side re-pointed a binding at another module. That is right when the
// module merely moved and the merge carried the other side's edits into the moved copy. It is wrong when
// the other side changed the old module, or anything it imports, and those edits never reach the new
// one: the 2026-11-15 merge wrote exactly that, upstream taking `WorktreeStatus` from a shared rollup
// module while the fork had added `'setup'` to the renderer's own, and `tsc` failed four times.
//
// The comparison is the whole old module and its import closure, not the binding's declaration: a
// declaration-level diff missed re-exports, `export *`, aliases, default and namespace imports, non-script
// modules and a change to what the declaration depends on. That costs coverage; it does not write a
// wrong file. Anything that cannot be traced refuses.
import { modulePaths, resolvesInIndex } from './conflict-module-resolve.mjs'
import { parseSource, ts } from './ts-source.mjs'

export const SIDES = ['base', 'ours', 'theirs']

/**
 * `history` from three sides: `files[side]` is a Set of paths or a Map of path -> blob oid (compared by
 * oid when both are Maps), `read(side, path)` the text or null, `renames[side]` a Map of base path ->
 * that side's path, `prefetch(side, paths)` an optional bulk read whose Map of path -> text seeds `read`,
 * and `carries({ now, old, other, taker })` whether the merged copy of `now` is the merge's own
 * three-way result of the old module's edits (false when that cannot be shown).
 */
export function providerHistory({ files, read, renames, prefetch = null, carries = () => false }) {
  const texts = new Map()
  const blob = (side, path) => {
    const key = `${side}\u0000${path}`
    if (!texts.has(key)) {
      texts.set(key, files[side].has(path) ? read(side, path) : null)
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
  const resolve = (side, from, specifier, kind = 'type') => {
    let hit = null
    resolvesInIndex(
      from,
      specifier,
      (candidate) => {
        const found = files[side].has(candidate)
        hit ??= found ? candidate : null
        return found
      },
      kind
    )
    return hit
  }
  /** Whether `side` holds base's `basePath` byte for byte, wherever it renamed it to. */
  const unchanged = (side, basePath) => {
    const there = renamedTo(side, basePath)
    if (files.base instanceof Map && files[side] instanceof Map) {
      return files.base.has(basePath) && files.base.get(basePath) === files[side].get(there)
    }
    const text = blob('base', basePath)
    return text !== null && text === blob(side, there)
  }
  const warm = (paths) => {
    const cold = paths.filter((path) => !texts.has(`base\u0000${path}`) && files.base.has(path))
    for (const [path, text] of prefetch && cold.length > 0 ? prefetch('base', cold) : []) {
      texts.set(`base\u0000${path}`, text)
    }
  }
  const closures = new Map()
  /** `basePath` and every module it reaches through path imports in base; null if one is untraceable. */
  const closure = (basePath) => {
    if (!closures.has(basePath)) {
      closures.set(basePath, traceClosure(basePath, { blob, resolve, warm }))
    }
    return closures.get(basePath)
  }
  return { blob, renamedTo, basePathOf, resolve, unchanged, closure, carries }
}

/** Breadth-first, one bulk read per level: a shared module's closure runs to thousands of files. */
function traceClosure(start, { blob, resolve, warm }) {
  const seen = new Set([start])
  let level = [start]
  while (level.length > 0) {
    warm(level)
    const next = []
    for (const at of level) {
      const parsed = parseSource(at, blob('base', at))
      if (parsed === null) {
        continue // not a script: its bytes are compared, and it imports nothing
      }
      if (parsed.broken) {
        return null
      }
      for (const { specifier, kind } of modulePaths(parsed.sf)) {
        const found = resolve('base', at, specifier, kind)
        if (found === null) {
          return null // an `@orca/` package or a path base cannot resolve: untraceable
        }
        if (!seen.has(found)) {
          seen.add(found)
          next.push(found)
        }
      }
    }
    level = next
  }
  return [...seen]
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
 * the new module changed the old module or anything it imports, and the merge cannot be shown to have
 * carried that change into the new module. `sides` holds each stage's parsed file; `null` history
 * refuses any re-pointed name.
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
      found.push(`${name} (its old module ${old ?? was} cannot be traced)`)
      continue
    }
    const other = taker === 'ours' ? 'theirs' : 'ours'
    // Moved, not swapped, only when the merged copy of the new module is the merge's own result of the
    // old one's edits (`git diff -M`'s pairing is not the merge's). What the moved module imports is
    // merged file by file, so its closure is not this importer's question.
    const now = history.resolve(taker, history.renamedTo(taker, basePath), specifier)
    if (
      now !== null &&
      now === history.renamedTo(taker, old) &&
      history.carries({ now, old, other, taker })
    ) {
      continue
    }
    const reach = history.closure(old)
    if (reach === null) {
      found.push(`${name} (what its old module ${old} imports cannot be traced)`)
      continue
    }
    const changed = reach.filter((at) => !history.unchanged(other, at))
    if (changed.length === 0) {
      continue
    }
    found.push(
      `${name} (now from ${now ?? specifier}; ${other} changed ${changed.slice(0, 3).join(', ')})`
    )
  }
  return found
}
