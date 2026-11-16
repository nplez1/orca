// The whole-file gate a resolution passes after every hunk in it is proven: `conflict-prove.mjs` has the
// tiers and the reasons this exists. Pure: the index facts (`moduleExists`, the three stages) are injected.
import { ALIAS_PREFIXES, WORKSPACE_PREFIX, resolvesInIndex } from './conflict-module-resolve.mjs'
import { swappedProviders } from './conflict-provider-gate.mjs'
import { parseSource, ts } from './ts-source.mjs'

export { resolvesInIndex }

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

// `vi.mock('../x')` and friends carry a module path exactly as an import does.
const PATH_CALLEE =
  /^(?:require|require\.resolve|(?:vi|vitest|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock))$/

const isPathSpecifier = (text) =>
  /^\.\.?(?:\/|$)/.test(text) ||
  ALIAS_PREFIXES.some((alias) => text.startsWith(alias)) ||
  text.startsWith(WORKSPACE_PREFIX)

const isTypeOnly = (node) =>
  Boolean(
    (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
    (ts.isExportDeclaration(node) && node.isTypeOnly)
  )

/**
 * Relative, aliased and workspace module specifiers in a parsed file, each with how it is resolved:
 * `type` (may name a `.d.ts`), `value`, or `url` (a `new URL(…, import.meta.url)`: the exact path).
 */
export function modulePaths(sf) {
  const found = new Map()
  const take = (node, kind) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      if (isPathSpecifier(node.text) && !found.has(`${kind}\u0000${node.text}`)) {
        found.set(`${kind}\u0000${node.text}`, { specifier: node.text, kind })
      }
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier, isTypeOnly(node) ? 'type' : 'value')
    } else if (ts.isExternalModuleReference(node)) {
      take(node.expression, 'value')
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal, 'type')
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        PATH_CALLEE.test(node.expression.getText(sf)))
    ) {
      take(node.arguments[0], 'value')
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(sf) === 'URL' &&
      node.arguments?.[1]?.getText(sf) === 'import.meta.url'
    ) {
      take(node.arguments[0], 'url')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...found.values()]
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

/**
 * Identifier texts used outside import declarations, and the names the file declares anywhere. A text
 * scan, not a binder: a shadowing declaration in some inner scope hides a use, and a false hit only
 * refuses.
 */
function referencesAndDeclarations(sf) {
  const used = new Set()
  const declared = new Set()
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      if (DECLARES.has(parent.kind) && parent.name === node) {
        declared.add(node.text)
      } else if (
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
  return { used, declared }
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
