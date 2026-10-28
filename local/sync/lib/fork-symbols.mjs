// Post-merge fork-symbol survival: names the fork added to a file (old-base..pre-sync tip) that the
// merged file no longer declares. Pure: file texts in, verdict out.
//
// `deletedForkModules` covers a fork module that disappeared; this covers the case that has dropped
// fork behaviour silently at least four times: the file survives the merge, the fork's function,
// constant or settings field inside it does not. A name is a top-level declaration or a member of a
// top-level class, interface, type literal, enum or object-literal constant (`Container.member`).
import { lineOf, parseSource, ts } from './ts-source.mjs'

const hasExport = (node) =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  )

function memberName(member) {
  const name = member.name
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))) {
    return name.text
  }
  return ts.isShorthandPropertyAssignment(member) ? member.name.text : null
}

function unwrap(expression) {
  let current = expression
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function typeMembers(type) {
  if (!type) {
    return []
  }
  if (ts.isTypeLiteralNode(type)) {
    return type.members
  }
  if (ts.isIntersectionTypeNode(type)) {
    return type.types.flatMap(typeMembers)
  }
  return []
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) {
    return [name]
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  )
}

/** Map(qualified name -> { name, kind, exported, line }) of what a caller or a reader could miss. */
export function forkSurface(file, text) {
  const parsed = parseSource(file, text)
  const symbols = new Map()
  if (parsed === null || parsed.broken) {
    return null
  }
  const { sf } = parsed
  const add = (name, kind, exported, node) => {
    if (name && !symbols.has(name)) {
      symbols.set(name, { name, kind, exported, line: lineOf(sf, node) })
    }
  }
  const addMembers = (owner, members, exported) => {
    for (const member of members) {
      add(memberName(member) && `${owner}.${memberName(member)}`, 'member', exported, member)
    }
  }
  for (const statement of sf.statements) {
    const exported = hasExport(statement)
    const name = statement.name?.text
    if (ts.isFunctionDeclaration(statement)) {
      add(name, 'function', exported, statement)
    } else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      add(name, ts.isClassDeclaration(statement) ? 'class' : 'interface', exported, statement)
      addMembers(name, statement.members, exported)
    } else if (ts.isTypeAliasDeclaration(statement)) {
      add(name, 'type', exported, statement)
      addMembers(name, typeMembers(statement.type), exported)
    } else if (ts.isEnumDeclaration(statement)) {
      add(name, 'enum', exported, statement)
      addMembers(name, statement.members, exported)
    } else if (ts.isModuleDeclaration(statement)) {
      add(name, 'namespace', exported, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const id of bindingNames(declaration.name)) {
          add(id.text, 'const', exported, declaration)
        }
        const value = unwrap(declaration.initializer)
        if (ts.isIdentifier(declaration.name) && value && ts.isObjectLiteralExpression(value)) {
          addMembers(declaration.name.text, value.properties, exported)
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        add(element.name.text, 're-export', true, element)
      }
    }
  }
  return symbols
}

/** What the tip declares that old-base did not; `before` is null for a file the fork added. */
export function forkAdded(before, after) {
  return [...after.values()].filter((symbol) => !before?.has(symbol.name))
}

/**
 * Per lost name: `acknowledged` (a settled manifest entry), `relocated` (its bare name still appears
 * on a merged line the fork did not add, so it may have moved; still unreviewed) or `lost`.
 * A manifest entry with status `restore` never acknowledges: it says the name must come back.
 */
export function survivalVerdict({ path, added, merged, referenced, acknowledgements }) {
  const results = []
  for (const symbol of added) {
    if (merged?.has(symbol.name)) {
      continue
    }
    const bare = symbol.name.split('.').at(-1)
    const ack = acknowledgements.find(
      (entry) => entry.path === path && entry.symbol === symbol.name
    )
    const verdict =
      ack?.status === 'expected-deletion'
        ? 'acknowledged'
        : referenced.has(bare)
          ? 'relocated'
          : 'lost'
    results.push({ path, ...symbol, verdict, supersededBy: ack?.supersededBy ?? null })
  }
  return results
}

/** The entry a reviewer pastes under `symbols` in expected-deletions.json once they have judged it. */
export const manifestEntry = (result) => ({
  path: result.path,
  symbol: result.name,
  status: 'pending-decision',
  supersededBy: null,
  reason: ''
})
