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
// Everything else is unproven, and a file is written only when every hunk in it is proven.
import { createHash } from 'node:crypto'
import { parseConflictHunks } from './conflict-classify.mjs'
import { isJsDoc, parseSource, scriptKindFor, ts } from './ts-source.mjs'

export const PROOF_TIERS = ['upstream-unchanged', 'fork-unchanged', 'identity-only', 'import-only']

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

// `getStart` skips a JSX text's leading whitespace, which renders when it sits on one line.
const tokenStart = (node, sf) =>
  node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sf)

function normalizedLeaf(node, sf) {
  const text = sf.text.slice(tokenStart(node, sf), node.getEnd())
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
    if (isJsDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken) {
      return
    }
    const nodeStart = tokenStart(node, sf)
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

/** Every comment's [pos, end), read from the trivia before each token so JSX text never counts as one. */
export function commentRanges(sf) {
  const ranges = new Map()
  const visit = (node) => {
    if (isJsDoc(node)) {
      return
    }
    const children = node.getChildren(sf)
    if (children.length === 0 && node.kind !== ts.SyntaxKind.JsxText) {
      for (const range of ts.getLeadingCommentRanges(sf.text, node.pos) ?? []) {
        ranges.set(range.pos, range.end)
      }
    }
    children.forEach(visit)
  }
  visit(sf)
  return [...ranges]
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

function importFacts(node) {
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
  const sig = (name) => signature(sides[name].entries, sides[name].sf)
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

/**
 * Proofs for one conflicted file. `resolvedText` is set only when every hunk is proven; callers that
 * serialise the result drop it, and `--apply-proven` recomputes it rather than trusting a file.
 *
 * @param {{ path: string, status?: string | null, merged?: string | null }} args
 */
export function proveFile({ path, status = null, merged = null }) {
  const base = { path, mergedSha: merged === null ? null : sha256(merged), fullyProven: false }
  if (merged === null || (status !== null && status !== 'UU')) {
    return {
      ...base,
      hunkCount: 0,
      provenHunks: 0,
      identitySweep: false,
      hunks: [],
      reason: status ? `status ${status} is not a both-modified file` : 'no merged content'
    }
  }
  const hunks = parseConflictHunks(merged)
  let trees = null
  if (scriptKindFor(path) !== null) {
    trees = {}
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
    result.resolvedText = resolvedText
    result.resolvedSha = sha256(resolvedText)
  }
  return result
}
