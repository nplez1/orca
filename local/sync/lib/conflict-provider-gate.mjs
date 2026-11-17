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
// modules and a change to what the declaration depends on. The binding is paired by the file it resolves
// to, not by specifier text, since a relative specifier re-means when its importer moves. That costs
// coverage; it does not write a wrong file. Anything that cannot be traced refuses.
import { modulePaths, resolvesInIndex } from './conflict-module-resolve.mjs'
import { parseSource, scriptKindFor, ts } from './ts-source.mjs'

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
  /** Whether `side`'s tree holds `at` at all; no read, so a candidate can be probed cheaply. */
  const has = (side, at) => files[side].has(at)
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
  /** `basePath`'s closure through path imports in base (`{ files, edges }`); null if untraceable. */
  const closure = (basePath) => {
    if (!closures.has(basePath)) {
      closures.set(basePath, traceClosure(basePath, { blob, resolve, warm }))
    }
    return closures.get(basePath)
  }
  return { blob, has, renamedTo, basePathOf, resolve, unchanged, closure, carries }
}

/**
 * Breadth-first, one bulk read per level: a shared module's closure runs to thousands of files. Returns
 * the files and every import edge (`[from, specifier, kind, to]`), so the other side's resolution of
 * each edge can be checked as well as its bytes.
 */
function traceClosure(start, { blob, resolve, warm }) {
  const seen = new Set([start])
  const edges = []
  let level = [start]
  while (level.length > 0) {
    warm(level)
    const next = []
    for (const at of level) {
      const text = blob('base', at)
      // A script whose bytes could not be read is not a leaf: what it imports is unchecked, so refuse.
      if (text === null && scriptKindFor(at) !== null) {
        return null
      }
      const parsed = parseSource(at, text)
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
        edges.push([at, specifier, kind, found])
        if (!seen.has(found)) {
          seen.add(found)
          next.push(found)
        }
      }
    }
    level = next
  }
  return { files: [...seen], edges }
}

const reExportNames = (clause) =>
  ts.isNamespaceExport(clause)
    ? [`export ${clause.name.text}`]
    : clause.elements.map((element) => `export ${element.name.text}`)

/**
 * What the file takes from other modules, keyed so a re-export never matches an import. `named` pairs a
 * binding with its specifier: an imported name, an `import x = require()`, or a named re-export keyed
 * `export <name>`. `unnamed` is the module references with no binding of their own — `import './x'`,
 * `export * from './x'`, a dynamic `import('./x')` — compared as a set, since there is no name to pair.
 */
const importSources = (sf) => {
  const named = new Map()
  const unnamed = new Set()
  const reference = (specifier) => {
    if (isModulePath(specifier)) {
      unnamed.add(specifier)
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const names = [
        clause?.name?.text,
        ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map((item) => item.name.text)
          : [clause?.namedBindings?.name?.text])
      ].filter(Boolean)
      if (names.length === 0) {
        reference(node.moduleSpecifier.text)
      }
      for (const name of names) {
        named.set(name, node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const expression = ts.isExternalModuleReference(node.moduleReference)
        ? node.moduleReference.expression
        : null
      if (expression && ts.isStringLiteralLike(expression)) {
        named.set(node.name.text, expression.text)
      }
      return
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (node.exportClause) {
        for (const key of reExportNames(node.exportClause)) {
          named.set(key, node.moduleSpecifier.text)
        }
      } else {
        reference(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier && ts.isStringLiteralLike(specifier)) {
        reference(specifier.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { named, unnamed }
}

const isPath = (specifier) => /^(?:\.\.?(?:\/|$)|@\/|@renderer\/)/.test(specifier)
const isRelative = (specifier) => /^\.\.?(?:\/|$)/.test(specifier)
// A workspace package is a module the fork can edit like any other, but this check has no way to trace
// its `exports` through history, so a re-point away from one refuses. Bare npm packages are skipped.
const isWorkspace = (specifier) => specifier.startsWith('@orca/')
const isModulePath = (specifier) => isPath(specifier) || isWorkspace(specifier)

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
  if (history === null) {
    for (const [name, specifier] of resolved.named) {
      const was = base.named.get(name)
      if (was !== undefined && was !== specifier && isModulePath(was)) {
        found.push(`${name} (no history to check its old module ${was} against)`)
      }
    }
    return found
  }
  const basePath = history.basePathOf(path)

  /**
   * Where the merged file's `specifier` points. The merged file sits at `path`, so it is resolved from
   * there in a tree that holds `path` — the writer's copy of the text, then the other side's, then base's
   * — never from the pre-merge path, because a relative specifier re-means when its importer moves.
   * A path no side's tree holds (a conflict git reports at a path no commit carries) falls back to the
   * pre-merge path, which is all there is to resolve against.
   */
  const resolveMerged = (writer, specifier) => {
    const side = [writer, 'theirs', 'ours', 'base'].find(
      (candidate) => candidate !== null && history.has(candidate, path)
    )
    if (side !== undefined) {
      return history.resolve(side, path, specifier)
    }
    return history.resolve(
      writer ?? 'base',
      history.renamedTo(writer ?? 'base', basePath),
      specifier
    )
  }

  /** Which side wrote the merged specifier (`null` when it is base's), and the file it names there. */
  const targetOf = (name, specifier) => {
    const writer =
      ours.named.get(name) === specifier
        ? 'ours'
        : theirs.named.get(name) === specifier
          ? 'theirs'
          : null
    return { writer, target: resolveMerged(writer, specifier) }
  }

  // Same bytes are not enough: the other side may resolve an edge elsewhere (a new `types.ts` that
  // TypeScript probes before base's `types/index.ts`), so each edge has to land on the same file.
  const changedIn = (reach, sources) =>
    sources.flatMap((side) => [
      ...reach.files.filter((at) => !history.unchanged(side, at)),
      ...reach.edges
        .filter(
          ([from, edge, kind, to]) =>
            history.resolve(side, history.renamedTo(side, from), edge, kind) !==
            history.renamedTo(side, to)
        )
        .map(([from, edge]) => `${from} -> ${edge}`)
    ])

  /**
   * The moved copy's own imports that no longer name the file base's did. A move is exempt from the
   * closure because the merge merged the moved module file by file — which holds only while a specifier
   * base also had still resolves, from the moved copy, to the merge's carried copy of that file. A
   * partial move (`a/m.ts` to `b/m.ts`, leaving `a/types.ts`) silently re-means `./types`; the merge
   * then leaves the moved copy importing a file that is not there, which `tsc` rejects.
   */
  const reMeaning = ({ now, old, taker }) => {
    const moved = parseSource(now, history.blob(taker, now))
    if (moved === null) {
      return [] // not a script: there is no import in it to re-mean
    }
    if (moved.broken) {
      return ['do not parse']
    }
    const was = parseSource(old, history.blob('base', old))
    if (was === null) {
      return []
    }
    if (was.broken) {
      return ['cannot be traced in base']
    }
    const before = new Map()
    for (const { specifier, kind } of modulePaths(was.sf)) {
      const to = history.resolve('base', old, specifier, kind)
      if (to !== null) {
        before.set(specifier, to)
      }
    }
    return modulePaths(moved.sf)
      .filter(({ specifier, kind }) => {
        const to = before.get(specifier)
        return (
          to !== undefined &&
          history.resolve(taker, now, specifier, kind) !== history.renamedTo(taker, to)
        )
      })
      .map(({ specifier }) => specifier)
  }

  const checkNamed = (name, specifier) => {
    const was = base.named.get(name)
    if (was === undefined || !isModulePath(was)) {
      return null // a binding the fork added, or one from a bare package upstream cannot have edited
    }
    // Unchanged text says nothing on its own: a relative specifier re-means when its importer moves, so
    // only an alias, a workspace package (both resolved from a project root), or an importer still at
    // its base path can be taken as the same module.
    if (specifier === was && (!isRelative(was) || basePath === path)) {
      return null
    }
    if (isWorkspace(was)) {
      return `${name} (its old module ${was} is a workspace package and cannot be traced)`
    }
    const old = history.resolve('base', basePath, was)
    if (old === null) {
      return `${name} (its old module ${was} cannot be traced)`
    }
    // The same specifier text can name another file once the importer moves, so compare the file, not
    // the text. Only the identical path is exempt: a module that moved still needs the `carries` proof.
    const { writer, target } = targetOf(name, specifier)
    if (target !== null && target === old) {
      return null
    }
    if (
      writer !== null &&
      target !== null &&
      target === history.renamedTo(writer, old) &&
      history.carries({
        now: target,
        old,
        other: writer === 'ours' ? 'theirs' : 'ours',
        taker: writer
      })
    ) {
      const broken = reMeaning({ now: target, old, taker: writer })
      return broken.length === 0
        ? null
        : `${name} (now from ${target}; the moved copy's ${broken.join(', ')} changed meaning)`
    }
    const reach = history.closure(old)
    if (reach === null) {
      return `${name} (what its old module ${old} imports cannot be traced)`
    }
    // No side wrote the merged specifier, so either of them can be the one that changed the old module.
    const sources = writer === null ? ['ours', 'theirs'] : [writer === 'ours' ? 'theirs' : 'ours']
    const changed = changedIn(reach, sources)
    if (changed.length === 0) {
      return null
    }
    return `${name} (now from ${target ?? specifier}; ${sources.join('/')} changed ${changed.slice(0, 3).join(', ')})`
  }

  /** A module reference base had, paired with the same reference in the resolution, or checked on its own. */
  const checkUnnamed = (specifier) => {
    const kept = resolved.unnamed.has(specifier)
    // An alias or a workspace package resolves from a project root, so its text is its module; a relative
    // one only keeps its meaning while its importer stays put.
    if (kept && (!isRelative(specifier) || basePath === path)) {
      return null
    }
    const old = history.resolve('base', basePath, specifier)
    if (old === null) {
      return `${specifier} (its old module cannot be traced)`
    }
    if (kept) {
      const target = resolveMerged(null, specifier)
      if (target !== null && target === old) {
        return null
      }
    }
    const reach = history.closure(old)
    if (reach === null) {
      return `${specifier} (what its old module ${old} imports cannot be traced)`
    }
    const changed = changedIn(reach, ['ours', 'theirs'])
    return changed.length === 0
      ? null
      : `${specifier} (no longer referenced, and they changed ${changed.slice(0, 3).join(', ')})`
  }

  for (const [name, specifier] of resolved.named) {
    const reason = checkNamed(name, specifier)
    if (reason !== null) {
      found.push(reason)
    }
  }
  for (const specifier of base.unnamed) {
    const reason = checkUnnamed(specifier)
    if (reason !== null) {
      found.push(reason)
    }
  }
  return found
}
