// Per-hunk proofs for `conflicts.mjs --propose` / `--apply-proven`. Pure: merged text in, proofs out.
//
// A hunk is PROVEN only when one of these holds, checked strongest first, on the syntax tree of each
// side reconstructed as a whole file (so a hunk inside a template literal or a comment is read as one):
//   upstream-unchanged  theirs == base after dropping comments and whitespace     -> ours
//   fork-unchanged      ours == base after the same strip                         -> theirs
//   identity-only       ours differs from base only by fork identity literals     -> theirs, with
//                       the same literals re-applied token-for-token; re-run the identity sweep
//   import-only         every side is import declarations only                    -> three-way union
// A token or comment crossing a hunk edge on any side refuses the hunk: its meaning lives outside it.
// Everything else is unproven, and a file is written only when every hunk in it is proven AND the
// resolved file passes the whole-file gate in `conflict-file-gate.mjs`: module paths that resolve in
// the merged index, no import a stage removed, no use left unbound, no re-pointed binding that loses
// the other side's edit.
//
// That gate exists because no tier above can see the tree, git's clean merge, or another file. In the
// 2026-11-15 sync 88 of 189 "proven" files differed from the merge that shipped: stale paths after
// upstream's reorganisation, orphaned imports, and one binding re-pointed at a module the fork's edit
// never reached. The gate refuses all 88; the 84 files it still writes are byte-identical.
//
// Comments are not always noise. A directive comment (`@vitest-environment`, `@ts-expect-error`,
// `eslint-disable`, `/// <reference>`, a JSDoc type in a JS file) *is* code: dropping one changes a test
// environment or turns a suppressed error into a real one. Those comments are signature tokens, so a
// hunk whose directives differ on one side is unproven however little code it changes.
import { createHash } from 'node:crypto'
import { parseConflictHunks } from './conflict-classify.mjs'
import { importFacts, resolvedFileGate } from './conflict-file-gate.mjs'
import { isJsDoc, parseSource, scriptKindFor, ts } from './ts-source.mjs'

export const PROOF_TIERS = ['upstream-unchanged', 'fork-unchanged', 'identity-only', 'import-only']

// A comment that changes what a compiler, a linter or a test runner does. Prose is not here: a hunk
// where upstream only reworded a sentence is still `upstream-unchanged`.
const DIRECTIVE_COMMENT = [
  /@vitest-environment(?:-options)?\b/,
  /@ts-expect-error\b/,
  /@ts-ignore\b/,
  /@ts-nocheck\b/,
  /@ts-check\b/,
  /@jsx(?:ImportSource|Frag)?\b/,
  /@__PURE__\b/,
  /\b(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/,
  /\bast-grep-ignore\b/,
  /\bprettier-ignore\b/,
  /\boxfmt-ignore\b/,
  /\bbiome-ignore\b/,
  /\bv8 ignore\b/,
  /^\s*\/\/\/\s*<reference\b/
]
// `@param {T}`, `@type {T}` and friends only typecheck in JS, so they are tokens only for a JS file.
const JSDOC_TYPE =
  /@(?:param|arg|argument|type|returns?|typedef|property|prop|template|callback|this)\b[^\n]*\{/
const JS_EXTENSIONS = /\.(?:[cm]?js|jsx)$/

/**
 * Comments that carry a directive, as comparable tokens. `comments` is `commentRanges`' map.
 *
 * A comment that merely OVERLAPS the region counts: a hunk inside a `/** … *\/` block (or a multi-line
 * `eslint-disable` block) starts after the comment does, and skipping those made the directive invisible
 * exactly when the change was to the directive itself. A comment that crosses an edge rather than
 * enclosing the region is refused earlier, so overlap here cannot smuggle one in.
 */
export function directiveTokens({ comments, text, range, jsDocTypes = false }) {
  const [start, end] = range
  const tokens = []
  for (const [from, to] of comments) {
    if (to <= start || from >= end) {
      continue
    }
    const raw = text.slice(from, to)
    const isDoc = /^\s*\/\*\*/.test(raw)
    if (DIRECTIVE_COMMENT.some((pattern) => pattern.test(raw))) {
      tokens.push(raw)
    } else if (isDoc && jsDocTypes && JSDOC_TYPE.test(raw)) {
      tokens.push(raw)
    }
  }
  return tokens.sort()
}

// Fork literal -> upstream literal, longest first (LOCAL-PATCHES.md `local(identity)`).
export const IDENTITY_PAIRS = [
  ['com.nplez1.orca', 'com.stablyai.orca'],
  ['nplez1/orca', 'stablyai/orca'],
  ['.orca-np', '.orca'],
  ['orca-np', 'orca'],
  ['Orca NP', 'Orca'],
  ['OrcaNP', 'Orca']
]

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

export function upstreamIdentity(text) {
  let out = text
  for (const [fork, upstream] of IDENTITY_PAIRS) {
    out = out.split(fork).join(upstream)
  }
  return out
}

/** The merged file with every hunk replaced by one side, and each hunk's character range in it. */
export function reconstruct(merged, hunks, side) {
  const rows = merged.split('\n')
  const out = []
  const ranges = []
  let offset = 0
  let row = 0
  const push = (line) => {
    out.push(line)
    offset += line.length + 1
  }
  for (const hunk of hunks) {
    while (row < hunk.startLine - 1) {
      push(rows[row])
      row += 1
    }
    const start = offset
    const lines = hunk[side] ?? []
    lines.forEach(push)
    ranges.push([start, Math.max(start, offset - 1)])
    row = hunk.endLine
  }
  while (row < rows.length) {
    push(rows[row])
    row += 1
  }
  return { text: out.join('\n'), ranges }
}

// JSX whitespace renders unless it holds a newline, so a text's own line is where it starts.
function regionStart(node, sf) {
  const start = node.getStart(sf)
  if (node.kind !== ts.SyntaxKind.JsxText) {
    return start
  }
  const lead = sf.text.slice(node.pos, start)
  return node.pos + Math.max(lead.lastIndexOf('\n'), lead.lastIndexOf('\r')) + 1
}

function normalizedLeaf(node, sf) {
  // `getStart` skips a JSX text's leading whitespace, which renders when it sits on one line.
  const from = node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sf)
  const text = sf.text.slice(from, node.getEnd())
  if (node.kind === ts.SyntaxKind.JsxText) {
    // JSX drops only whitespace runs that contain a newline; a space on a single line renders.
    const lines = text.split(/\r\n|\r|\n/)
    return lines
      .map((line, row) => {
        const head = row === 0 ? line : line.replace(/^[ \t]+/, '')
        return row === lines.length - 1 ? head : head.replace(/[ \t]+$/, '')
      })
      .filter(Boolean)
      .join(' ')
  }
  return text
}

function pushSubtree(node, sf, entries) {
  if (isJsDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken) {
    return
  }
  const children = node.getChildren(sf)
  entries.push({ node, leaf: children.length === 0, kind: node.kind })
  for (const child of children) {
    pushSubtree(child, sf, entries)
  }
}

/** Nodes wholly inside [start, end) in preorder, the outermost of them as `roots`, and whether a token straddles an edge. */
export function regionNodes(sf, [start, end]) {
  const entries = []
  const roots = []
  let straddles = false
  const visit = (node) => {
    // Whitespace between JSX children on separate lines never renders, and it spans the line break.
    if (
      isJsDoc(node) ||
      node.kind === ts.SyntaxKind.EndOfFileToken ||
      (node.kind === ts.SyntaxKind.JsxText && node.containsOnlyTriviaWhiteSpaces)
    ) {
      return
    }
    const nodeStart = regionStart(node, sf)
    const nodeEnd = node.getEnd()
    if (nodeEnd <= start || nodeStart >= end || nodeStart === nodeEnd) {
      return
    }
    // A SyntaxList is the parser's container, not a statement; its members are the real roots.
    if (nodeStart >= start && nodeEnd <= end && node.kind !== ts.SyntaxKind.SyntaxList) {
      roots.push(node)
      pushSubtree(node, sf, entries)
      return
    }
    const children = node.getChildren(sf)
    if (children.length === 0) {
      straddles = true
      return
    }
    children.forEach(visit)
  }
  visit(sf)
  return { entries, roots, straddles }
}

/** Every comment's [pos, end), read from the trivia around each token so JSX text never counts as one. */
export function commentRanges(sf) {
  const ranges = new Map()
  const jsxTexts = []
  const visit = (node) => {
    if (isJsDoc(node)) {
      // The parser attaches a JSDoc block as a NODE (often of the end-of-file token, for one that trails
      // the last statement), so it is never reached as trivia and skipping it lost the directive it may
      // carry. Its own range is the comment.
      ranges.set(node.pos, node.end)
      return
    }
    const children = node.getChildren(sf)
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTexts.push([node.pos, node.end])
    } else if (children.length === 0) {
      // A comment opening on the previous token's line is that token's trailing comment, not a leading one.
      for (const range of [
        ...(ts.getLeadingCommentRanges(sf.text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(sf.text, node.end) ?? [])
      ]) {
        ranges.set(range.pos, range.end)
      }
    }
    children.forEach(visit)
  }
  visit(sf)
  // A trailing scan from a JSX tag's `>` reads the text after it as trivia.
  return [...ranges].filter(([pos]) => !jsxTexts.some(([from, to]) => pos >= from && pos < to))
}

/** `crosses` when a comment runs over one edge of [start, end), `enclosed` when one spans both. */
function commentEdge(comments, [start, end]) {
  let enclosed = false
  for (const [from, to] of comments) {
    if (from < start && to > end) {
      enclosed = true
    } else if ((from < start && to > start) || (from < end && to > end)) {
      return 'crosses'
    }
  }
  return enclosed ? 'enclosed' : 'clear'
}

const signature = (entries, sf) =>
  entries
    .map((entry) =>
      entry.leaf ? `${entry.kind}:${normalizedLeaf(entry.node, sf)}` : `${entry.kind}`
    )
    .join('\n')

function identityMap(base, ours) {
  if (base.entries.length !== ours.entries.length) {
    return null
  }
  const map = new Map()
  const kept = new Set()
  for (let index = 0; index < base.entries.length; index += 1) {
    const b = base.entries[index]
    const o = ours.entries[index]
    if (b.kind !== o.kind || b.leaf !== o.leaf) {
      return null
    }
    if (!b.leaf) {
      continue
    }
    const baseText = b.node.getText(base.sf)
    const oursText = o.node.getText(ours.sf)
    if (baseText === oursText) {
      kept.add(baseText)
      continue
    }
    if (upstreamIdentity(oursText) !== baseText || (map.get(baseText) ?? oursText) !== oursText) {
      return null
    }
    map.set(baseText, oursText)
  }
  // A literal the fork rebranded in one place and kept in another has no token-level answer.
  if (map.size === 0 || [...map.keys()].some((text) => kept.has(text))) {
    return null
  }
  return map
}

const leafCount = (side, text) =>
  side.entries.filter((entry) => entry.leaf && entry.node.getText(side.sf) === text).length

/** Theirs' region with each base literal ours rebranded swapped for ours' text; null unless theirs has exactly base's occurrences. */
function reapplyIdentity(theirs, base, map) {
  if ([...map.keys()].some((text) => leafCount(theirs, text) !== leafCount(base, text))) {
    return null
  }
  const [start, end] = theirs.range
  const edits = []
  for (const entry of theirs.entries) {
    const text = entry.leaf ? entry.node.getText(theirs.sf) : null
    if (text !== null && map.has(text)) {
      edits.push([entry.node.getStart(theirs.sf), entry.node.getEnd(), map.get(text)])
    }
  }
  let out = theirs.sf.text.slice(start, end)
  for (const [from, to, text] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, from - start) + text + out.slice(to - start)
  }
  return out.split('\n')
}

/** The side's import declarations outside its hunk region; other hunks count on either side. */
const importsOutside = (side) =>
  side.sf.statements
    .filter((statement) => ts.isImportDeclaration(statement))
    .filter(
      (statement) =>
        statement.getEnd() <= side.range[0] || statement.getStart(side.sf) >= side.range[1]
    )
    .map(importFacts)

/** Three-way union of import declarations, or null when it would duplicate a module or a binding. */
function importUnion(sides) {
  const keyed = {}
  for (const name of ['base', 'ours', 'theirs']) {
    const side = sides[name]
    if (!side.roots.every((root) => ts.isImportDeclaration(root))) {
      return null
    }
    keyed[name] = side.roots.map((root, at) => {
      const entries = []
      pushSubtree(root, side.sf, entries)
      const start = Math.max(root.getFullStart(), side.range[0])
      // The last import carries the rest of the region, so a trailing comment travels with it.
      const end = at === side.roots.length - 1 ? side.range[1] : root.getEnd()
      const text = side.sf.text
        .slice(start, end)
        .replace(/^(?:[ \t]*\r?\n)+/, '')
        .trimEnd()
      return { key: signature(entries, side.sf), text, facts: importFacts(root) }
    })
  }
  if (keyed.ours.length + keyed.theirs.length === 0) {
    return null
  }
  const moduleKeys = (name) => new Map(keyed[name].map((item) => [item.facts.module, item.key]))
  const [baseModules, oursModules, theirsModules] = ['base', 'ours', 'theirs'].map(moduleKeys)
  for (const [module, key] of baseModules) {
    for (const [gone, kept] of [
      [oursModules, theirsModules],
      [theirsModules, oursModules]
    ]) {
      // One side dropped the import and the other changed it: a modify/delete, not a union.
      if (!gone.has(module) && kept.has(module) && kept.get(module) !== key) {
        return null
      }
    }
  }
  // The same check by binding: a reorganisation changes the specifier, so "one side dropped `x`, the
  // other re-pointed `x` at the module's new home" has no module in common and passed the check above,
  // and the union kept an import the side that dropped it no longer uses.
  const nameKeys = (name) =>
    new Map(keyed[name].flatMap((item) => item.facts.names.map((bound) => [bound, item.key])))
  const [baseNames, oursNames, theirsNames] = ['base', 'ours', 'theirs'].map(nameKeys)
  for (const [bound, key] of baseNames) {
    for (const [gone, kept] of [
      [oursNames, theirsNames],
      [theirsNames, oursNames]
    ]) {
      if (!gone.has(bound) && kept.has(bound) && kept.get(bound) !== key) {
        return null
      }
    }
  }
  const keys = (name) => new Set(keyed[name].map((item) => item.key))
  const [base, ours, theirs] = [keys('base'), keys('ours'), keys('theirs')]
  const merged = [
    ...keyed.ours.filter((item) => !base.has(item.key) || theirs.has(item.key)),
    ...keyed.theirs.filter((item) => !base.has(item.key) && !ours.has(item.key))
  ]
  const elsewhere = ['ours', 'theirs'].flatMap((name) => importsOutside(sides[name]))
  const outsideModules = new Set(elsewhere.map((facts) => facts.module))
  const outsideNames = new Set(elsewhere.flatMap((facts) => facts.names))
  const modules = merged.map((item) => item.facts.module)
  const names = merged.flatMap((item) => item.facts.names)
  if (
    new Set(modules).size !== modules.length ||
    new Set(names).size !== names.length ||
    modules.some((module) => outsideModules.has(module)) ||
    names.some((name) => outsideNames.has(name))
  ) {
    return null
  }
  return merged.flatMap((item) => item.text.split('\n'))
}

const unproven = (reason) => ({ tier: null, action: null, reason, resolution: null })

/** One hunk's proof. `trees` holds each side's parsed reconstruction; `index` is the hunk's position. */
export function proveHunk(hunk, trees, index) {
  if (hunk.base === null) {
    return unproven('no base section: merge.conflictStyle=zdiff3 records one')
  }
  if (trees === null) {
    return unproven('not a script or JSON file, so there is no token stream to compare')
  }
  if (trees.base.broken || trees.ours.broken || trees.theirs.broken) {
    return unproven('a side does not parse as a whole file')
  }
  const sides = {}
  const edges = new Set()
  for (const name of ['base', 'ours', 'theirs']) {
    const { sf, ranges, comments } = trees[name]
    sides[name] = { sf, range: ranges[index], ...regionNodes(sf, ranges[index]) }
    sides[name].directives = directiveTokens({
      comments,
      text: sf.text,
      range: sides[name].range,
      jsDocTypes: trees.jsDocTypes
    })
    if (sides[name].straddles) {
      return unproven(`the hunk edge splits a token on the ${name} side`)
    }
    const edge = commentEdge(comments, ranges[index])
    if (edge === 'crosses') {
      return unproven(`a comment crosses the hunk edge on the ${name} side`)
    }
    edges.add(edge)
  }
  if (edges.size > 1) {
    return unproven('the hunk sits inside a comment on some sides only')
  }
  const sig = (name) =>
    [signature(sides[name].entries, sides[name].sf), ...sides[name].directives].join('\n\u0000\n')
  if (sig('theirs') === sig('base')) {
    return {
      tier: 'upstream-unchanged',
      action: 'take-ours',
      reason: 'upstream changed only comments or whitespace here',
      resolution: hunk.ours
    }
  }
  if (sig('ours') === sig('base')) {
    return {
      tier: 'fork-unchanged',
      action: 'take-theirs',
      reason: 'the fork changed only comments or whitespace here',
      resolution: hunk.theirs
    }
  }
  // Any side whose directives differ from base's refuses the hunk, whichever side added or removed one.
  const directiveGap = ['base', 'ours', 'theirs'].find(
    (name) => sides[name].directives.join('\n') !== sides.base.directives.join('\n')
  )
  if (directiveGap) {
    return unproven(
      `the ${directiveGap} side's directive comments differ from base's: a directive is code, so this hunk needs a reviewer`
    )
  }
  const map = identityMap(sides.base, sides.ours)
  const rebranded = map ? reapplyIdentity(sides.theirs, sides.base, map) : null
  if (rebranded) {
    return {
      tier: 'identity-only',
      action: 'take-theirs+identity',
      reason: `the fork changed only identity literals here (${[...map.values()].join(', ')}); re-run identity-sweep.mjs`,
      resolution: rebranded
    }
  }
  const union = importUnion(sides)
  if (union) {
    return {
      tier: 'import-only',
      action: 'import-union',
      reason: 'imports only on every side; three-way union, no duplicate module or binding',
      resolution: union
    }
  }
  return unproven('no proof tier holds: both sides changed code here')
}

// Said in full because `--apply-proven` prints it: a bare "0/0 hunk(s) proven" read as a tool failure.
function notBothModified(status) {
  if (status === 'UD' || status === 'DU') {
    return `status ${status} is a modify/delete: there are no hunks to prove, so keeping or deleting it is a ledger, expected-deletions.json or reviewer decision`
  }
  return `status ${status} is not a both-modified file: there are no three-way hunks to prove`
}

/**
 * Proofs for one conflicted file. `resolvedText` is set only when every hunk is proven and every module
 * path in it resolves; callers that serialise the result drop it, and `--apply-proven` recomputes it
 * rather than trusting a file.
 *
 * `moduleExists(repoPath)` answers whether the merge will keep a file at that path. `conflicts.mjs`
 * reads it from the index: stage 0, or both sides' stages present — a modify/delete is undecided.
 * `stages` is the file's own `:1:`/`:2:`/`:3:` text. Without either, a script file is never written.
 *
 * @param {{ path: string, status?: string | null, merged?: string | null, moduleExists?: (path: string) => boolean, stages?: { base: string | null, ours: string | null, theirs: string | null } | null }} args
 */
export function proveFile({
  path,
  status = null,
  merged = null,
  moduleExists = null,
  stages = null
}) {
  const base = { path, mergedSha: merged === null ? null : sha256(merged), fullyProven: false }
  if (merged === null || (status !== null && status !== 'UU')) {
    return {
      ...base,
      hunkCount: 0,
      provenHunks: 0,
      identitySweep: false,
      hunks: [],
      reason: status ? notBothModified(status) : 'no merged content'
    }
  }
  const hunks = parseConflictHunks(merged)
  let trees = null
  if (scriptKindFor(path) !== null) {
    // An object, so the two fields below travel with the three per-side trees.
    trees = { jsDocTypes: JS_EXTENSIONS.test(path) }
    for (const side of ['base', 'ours', 'theirs']) {
      const rebuilt = reconstruct(merged, hunks, side)
      const parsed = parseSource(path, rebuilt.text)
      trees[side] = { ...parsed, ranges: rebuilt.ranges, comments: commentRanges(parsed.sf) }
    }
  }
  const proofs = hunks.map((hunk, index) => ({
    index: index + 1,
    startLine: hunk.startLine,
    endLine: hunk.endLine,
    ...proveHunk(hunk, trees, index)
  }))
  const proven = proofs.filter((proof) => proof.tier !== null).length
  const fullyProven = hunks.length > 0 && proven === hunks.length
  const result = {
    ...base,
    fullyProven,
    hunkCount: hunks.length,
    provenHunks: proven,
    identitySweep: proofs.some((proof) => proof.tier === 'identity-only'),
    hunks: proofs,
    reason: hunks.length === 0 ? 'no conflict markers' : null
  }
  if (fullyProven) {
    const resolvedText = reconstruct(
      merged,
      hunks.map((hunk, index) => ({ ...hunk, resolved: proofs[index].resolution })),
      'resolved'
    ).text
    // The whole file, not only the hunks: git's clean merge of a moved file keeps the old relative paths.
    const gate = resolvedFileGate(path, resolvedText, stages, moduleExists)
    if (gate !== null) {
      result.fullyProven = false
      result.reason = gate.reason
      result.unresolvedModules = gate.missing
      return result
    }
    result.resolvedText = resolvedText
    result.resolvedSha = sha256(resolvedText)
  }
  return result
}
