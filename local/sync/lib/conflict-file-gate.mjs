// The whole-file gate a resolution passes after every hunk in it is proven: `conflict-prove.mjs` has the
// tiers and the reasons this exists. Pure: the index facts (`moduleExists`, the three stages) are injected.
import { modulePaths, resolvesInIndex } from './conflict-module-resolve.mjs'
import { swappedProviders } from './conflict-provider-gate.mjs'
import { parseSource, ts } from './ts-source.mjs'

export { modulePaths, resolvesInIndex }

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

/**
 * The resolved file's module paths that name nothing the merged index keeps, or a reason it cannot be
 * checked. With no `moduleExists` there is nothing to check against, so any path refuses: a caller that
 * forgets the index must not get unchecked writes.
 */
function unresolvedModules(path, parsed, moduleExists) {
  const found = modulePaths(parsed.sf)
  const usable = typeof moduleExists === 'function' || typeof moduleExists?.exists === 'function'
  if (!usable) {
    return found.length === 0
      ? { reason: null, missing: [] }
      : {
          reason: 'no merged index to check its module paths against',
          missing: [...new Set(found.map((item) => item.specifier))]
        }
  }
  const missing = [
    ...new Set(
      found
        .filter((item) => !resolvesInIndex(path, item.specifier, moduleExists, item.kind))
        .map((item) => item.specifier)
    )
  ]
  return {
    reason:
      missing.length === 0
        ? null
        : `module path(s) that resolve to nothing the merge keeps: ${missing.join(', ')}`,
    missing
  }
}

/**
 * What a file binds or forwards from other modules: imported names, `import x = require()`, and
 * re-exports (`export { m } from`, `export * from`) keyed apart so a re-export never matches an import.
 */
const importedNames = (sf) =>
  new Set(
    sf.statements.flatMap((statement) => {
      if (ts.isImportDeclaration(statement)) {
        return importFacts(statement).names
      }
      if (ts.isImportEqualsDeclaration(statement)) {
        return [statement.name.text]
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const clause = statement.exportClause
        if (!clause) {
          return [`export * from ${statement.moduleSpecifier.text}`]
        }
        return ts.isNamespaceExport(clause)
          ? [`export ${clause.name.text}`]
          : clause.elements.map((element) => `export ${element.name.text}`)
      }
      return []
    })
  )

// An identifier in these slots names a member or a label, not a binding.
const NOT_A_REFERENCE = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement
])
// An identifier in these slots is the name being declared, not a use of anything.
const DECLARES = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.TypeParameter
])

const bindingNames = (name) =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
      )

/**
 * Names declared at module scope: top-level statements, top-level variable bindings, and the
 * declarations inside `declare global`. Only these can stand in for a dropped import; an inner
 * parameter, `<T>` or local const named like it binds nothing at module scope.
 */
function moduleScopeDeclarations(statements, declared = new Set()) {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindingNames(declaration.name).forEach((name) => declared.add(name))
      }
    } else if (
      ts.isModuleDeclaration(statement) &&
      (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0
    ) {
      if (statement.body && ts.isModuleBlock(statement.body)) {
        moduleScopeDeclarations(statement.body.statements, declared)
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      declared.add(statement.name.text)
    }
  }
  return declared
}

/**
 * Identifier texts used outside import declarations, and the module-scope names the file declares. A
 * text scan, not a binder: a use an inner declaration shadows still counts, and a false hit only refuses.
 */
function referencesAndDeclarations(sf) {
  const used = new Set()
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      if (
        !(DECLARES.has(parent.kind) && parent.name === node) &&
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(ts.isQualifiedName(parent) && parent.right === node) &&
        !(NOT_A_REFERENCE.has(parent.kind) && (parent.name === node || parent.label === node))
      ) {
        used.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { used, declared: moduleScopeDeclarations(sf.statements) }
}

/**
 * The three index stages parsed, or null. The stages are the real sides; the per-hunk reconstructions
 * already carry git's clean merge, so they cannot show an import one side removed: upstream moves the
 * line out of the hunk while the fork deletes it (and its use), the union drops the hunk's copy and the
 * moved copy survives, unused.
 */
function parsedStages(path, stages) {
  const parsed = ['base', 'ours', 'theirs'].map((side) => parseSource(path, stages?.[side] ?? null))
  return parsed.some((side) => side === null || side.broken) ? null : parsed.map((side) => side.sf)
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
  const stageFiles = parsedStages(path, stages)
  if (stageFiles === null) {
    return { reason: 'no parsable index stages to check its imports against', missing: [] }
  }
  const [base, ours, theirs] = stageFiles.map(importedNames)
  const resolved = importedNames(parsed.sf)
  const dropped = [...resolved].filter(
    (name) => base.has(name) && (!ours.has(name) || !theirs.has(name))
  )
  if (dropped.length > 0) {
    return {
      reason: `the resolved file still imports what one side removed: ${dropped.join(', ')}`,
      missing: []
    }
  }
  // The other direction: one side dropped `x`'s import while the other side's clean-merged code still
  // uses it, so the union drops `x` and leaves the use unbound.
  const { used, declared } = referencesAndDeclarations(parsed.sf)
  const unbound = [...base].filter(
    (name) =>
      !name.startsWith('export ') && !resolved.has(name) && !declared.has(name) && used.has(name)
  )
  if (unbound.length > 0) {
    return {
      reason: `the resolved file uses what it no longer imports: ${unbound.join(', ')}`,
      missing: []
    }
  }
  const swapped = swappedProviders({
    path,
    resolvedSf: parsed.sf,
    sides: { base: stageFiles[0], ours: stageFiles[1], theirs: stageFiles[2] },
    history: moduleExists?.history ?? null
  })
  if (swapped.length > 0) {
    return {
      reason: `the resolved file takes a binding from a module the other side's change never reached: ${swapped.join(', ')}`,
      missing: []
    }
  }
  return null
}
