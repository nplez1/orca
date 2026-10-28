// The one place the sync tools parse source. `typescript` in package.json is TypeScript 7, the native
// compiler, and ships no JavaScript API; `typescript-api` is the 6.x line aliased for exactly this.
import path from 'node:path'
import ts from 'typescript-api'

export { ts }

const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.json': ts.ScriptKind.JSON
}

export function scriptKindFor(file) {
  return SCRIPT_KINDS[path.posix.extname(file)] ?? null
}

/** A parsed source file, or null for a path that is not script/JSON. `broken` means it did not parse. */
export function parseSource(file, text) {
  const kind = scriptKindFor(file)
  if (kind === null || text === null || text === undefined) {
    return null
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  // `parseDiagnostics` is not in the public typings, but it is the parser's own error list.
  return { sf, broken: (sf.parseDiagnostics?.length ?? 0) > 0 }
}

export function isJsDoc(node) {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode
}

/** 1-based line of a node's first token. */
export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}
