// Post-merge fork-symbol survival: names the fork added to a file (old-base..pre-sync tip) that the
// merged file no longer declares. Pure: file texts in, verdict out.
//
// `deletedForkModules` covers a fork module that disappeared; this covers the case that has dropped
// fork behaviour silently at least four times: the file survives the merge, the fork's function,
// constant or settings field inside it does not. A name is a top-level declaration, a member of a
// top-level class, interface, type literal, enum or object literal, a member reached through an
// object literal a hook returns (`createUiSlice = (set) => ({ npFlag })`, `create(() => ({ forkField }))`,
// `DEFAULTS.nested.forkNested`), a member of `export default { … }`, or a channel string a top-level
// call registers (`ipcMain.handle('np:fork-channel', …)`). Zustand slices, factory calls and nested
// settings defaults are exactly where the fork's fields live, so a scan that only read a top-level
// object literal after `unwrap` returned nothing for the shapes that matter most.
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

/**
 * Every object literal an expression can expose, in source order: the literal itself, a concise arrow
 * or function body, the single `return` of a block body, any call argument, and the `as`/`satisfies`/
 * parenthesised forms of each. Zustand's `(set) => ({ … })` and `create(() => ({ … }))` are the shapes
 * the fork's settings fields actually take.
 */
export function exposedObjectLiterals(expression) {
  const found = []
  const visit = (node) => {
    const value = unwrap(node)
    if (!value || found.length > 64) {
      return
    }
    if (ts.isObjectLiteralExpression(value)) {
      found.push(value)
      return
    }
    if (
      ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value) ||
      ts.isFunctionDeclaration(value) ||
      ts.isMethodDeclaration(value)
    ) {
      const body = value.body
      if (!body) {
        return
      }
      if (ts.isBlock(body)) {
        const returns = body.statements.filter((statement) => ts.isReturnStatement(statement))
        if (returns.length === 1 && returns[0].expression) {
          visit(returns[0].expression)
        }
      } else {
        visit(body)
      }
      return
    }
    if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
      for (const argument of value.arguments ?? []) {
        visit(argument)
      }
    }
  }
  visit(expression)
  return found
}

// A channel a top-level call registers. A fork IPC channel is a name a merge drops with no marker: the
// handler file survives, the one registering line does not.
const CHANNEL_CALL =
  /(?:^|\.)(handle|handleOnce|on|once|onEvent|removeHandler|invoke|send|sendSync)$/

function channelName(call) {
  const callee = call.expression
  if (!callee || !CHANNEL_CALL.test(callee.getText())) {
    return null
  }
  const first = call.arguments[0]
  const text =
    first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ? first.text
      : null
  return text && text.length > 0 ? text : null
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
  // Members of an object literal, and of every literal nested under one of its properties.
  const addLiteral = (owner, literal, exported) => {
    for (const property of literal.properties) {
      const name = memberName(property)
      if (!name) {
        continue
      }
      add(`${owner}.${name}`, 'member', exported, property)
      if (ts.isPropertyAssignment(property)) {
        for (const nested of exposedObjectLiterals(property.initializer)) {
          addLiteral(`${owner}.${name}`, nested, exported)
        }
      }
    }
  }
  // A channel a top-level call registers, as its own name so a merge that drops the line is caught.
  const addChannels = (node) => {
    const visit = (child) => {
      if (ts.isCallExpression(child)) {
        const channel = channelName(child)
        if (channel) {
          add(`channel:${channel}`, 'channel', false, child)
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
  }
  for (const statement of sf.statements) {
    const exported = hasExport(statement)
    const name = statement.name?.text
    if (ts.isFunctionDeclaration(statement)) {
      add(name, 'function', exported, statement)
      // A factory's returned literal is where a hook's fields live.
      for (const literal of exposedObjectLiterals(statement)) {
        addLiteral(name, literal, exported)
      }
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
        if (ts.isIdentifier(declaration.name)) {
          for (const literal of exposedObjectLiterals(declaration.initializer)) {
            addLiteral(declaration.name.text, literal, exported)
          }
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      // `export default { forkMember }` has no name of its own, so its members hang off `default`.
      add('default', 'default', true, statement)
      for (const literal of exposedObjectLiterals(statement.expression)) {
        addLiteral('default', literal, true)
      }
      addChannels(statement.expression)
    } else if (ts.isExpressionStatement(statement)) {
      addChannels(statement)
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
