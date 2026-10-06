// Pure core for `local/sync/conflicts.mjs` — no git, no fs, so every rule is unit-testable from
// fixtures (see conflict-classify.test.mjs).
//
// ADVISORY ONLY. delimiterBalance counts `()[]{}` without stripping strings or comments, so a
// bracket inside a literal skews it; added/removed counts are multiset differences, not an LCS diff
// (a moved line is one removal plus one addition); member and rename detection are line-shape
// heuristics: a member is an indented `key: value` / `key = value`, an `x.set(key, ...)` argument,
// or a one-per-line quoted union/list entry. A class describes the shape of a conflict and names
// the question it leaves open; it is never the resolution. The decisions live in
// `local/sync/convergence-ledger.md`.

const START = /^<{7}(?: (.*))?$/
const BASE_MARK = /^\|{7}(?: (.*))?$/
const MIDDLE = /^={7,}$/
const END = /^>{7}(?: (.*))?$/

export const UNMERGED_STATUS = {
  UU: 'both modified',
  AA: 'both added',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
  DD: 'both deleted',
  U: 'unmerged'
}

// Class decided by the status code rather than by hunk shape.
const STATUS_CLASSES = {
  AA: 'add/add',
  AU: 'add/add',
  UA: 'add/add',
  UD: 'modify/delete',
  DU: 'modify/delete',
  DD: 'both-deleted'
}
// Higher wins when one file has several hunks; `inconclusive` outranks all, so an unclassified hunk
// is never reported as a confident class.
const SEVERITY = {
  union: 1,
  'rename-replay': 2,
  'duplicate-tail': 3,
  'both-rewrote': 4,
  'duplicate-members': 5,
  inconclusive: 6
}

// Kept out of the branches below only to stop the formatter exploding every object literal. Each
// reason describes the shape and ends in the one question the resolver has to answer; none of them
// is an instruction.
const REASON = {
  empty: 'empty conflict region — nothing to compare',
  rename:
    'same line shapes, different identifiers or paths — is this one rename replaying, or two independent changes?',
  bothChanged:
    'both sides changed content that already existed here — which change belongs in the merged file?',
  dedup: 'both sides add the same member, so a union would repeat it — which entry survives?',
  overlap: 'same region changed on both sides — which change belongs in the merged file?',
  union:
    'both sides balanced, added lines disjoint — do the added lines from both sides belong, and is the shared tail present exactly once?',
  tail: 'a side ends mid-expression and the shared tail closes it — does the tail close one side, both, or neither?',
  divergingTail:
    'the sides diverge before the shared tail could close either — one expression with two tails, or two competing replacements?',
  unbalanced:
    'unbalanced and the shared tail does not close it — which side expression is complete?'
}

/** Index of the next conflict start at or after `from`, or the end of the file. */
function nextHunkStart(rows, from) {
  for (let index = from; index < rows.length; index += 1) {
    if (START.test(rows[index])) {
      return index
    }
  }
  return rows.length
}

/** Split merged content into conflict regions. A nested marker is treated as content. */
export function parseConflictHunks(text) {
  const rows = text.split('\n')
  const hunks = []
  let current = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (current === null) {
      const start = START.exec(row)
      if (start) {
        current = { startLine: index + 1, oursLabel: start[1] ?? '', ours: [], base: null }
        current.theirs = []
        current.theirsLabel = ''
        current.section = 'ours'
      }
      continue
    }
    if (current.section === 'ours' && BASE_MARK.test(row)) {
      current.section = 'base'
      current.base = []
      continue
    }
    if (current.section !== 'theirs' && MIDDLE.test(row)) {
      current.section = 'theirs'
      continue
    }
    const end = current.section === 'theirs' ? END.exec(row) : null
    if (end) {
      current.endLine = index + 1
      current.theirsLabel = end[1] ?? ''
      // Bounded at the next conflict: searching to the end of the file let a later hunk's bracket
      // "close" this hunk's open expression.
      current.tail = rows.slice(index + 1, nextHunkStart(rows, index + 1))
      hunks.push(current)
      current = null
      continue
    }
    current[current.section].push(row)
  }
  return hunks
}

/** Open minus close for `()[]{}`. Strings and comments are not stripped — see the header. */
export function delimiterBalance(lines) {
  let balance = 0
  for (const line of lines) {
    for (const character of line) {
      if (character === '(' || character === '[' || character === '{') {
        balance += 1
      } else if (character === ')' || character === ']' || character === '}') {
        balance -= 1
      }
    }
  }
  return balance
}

const MATE = { '(': ')', '[': ']', '{': '}' }

/** Openers left unclosed by `lines`, innermost last. */
function openers(lines) {
  const stack = []
  for (const line of lines) {
    for (const character of line) {
      if (character === '(' || character === '[' || character === '{') {
        stack.push(character)
      } else if (character === ')' || character === ']' || character === '}') {
        stack.pop()
      }
    }
  }
  return stack
}

/** Lines shared at the start of both sides, the last of them only up to its first difference. */
function commonPrefix(ours, theirs) {
  const prefix = []
  for (let index = 0; index < Math.min(ours.length, theirs.length); index += 1) {
    if (ours[index] === theirs[index]) {
      prefix.push(ours[index])
      continue
    }
    let shared = 0
    while (shared < ours[index].length && ours[index][shared] === theirs[index][shared]) {
      shared += 1
    }
    if (shared > 0) {
      prefix.push(ours[index].slice(0, shared))
    }
    break
  }
  return prefix
}

/**
 * Line of the tail after `>>>>>>>` that closes the side's open brackets, or null. Only the matching
 * kind closes (`}` never closes `[`), and a nested opener inside the tail has to close first.
 */
function closesAt(tail, stack) {
  if (stack.length === 0) {
    return null
  }
  const open = [...stack]
  for (let index = 0; index < tail.length; index += 1) {
    for (const character of tail[index]) {
      if (character === '(' || character === '[' || character === '{') {
        open.push(character)
      } else if (character === ')' || character === ']' || character === '}') {
        if (MATE[open.at(-1)] !== character) {
          return null
        }
        open.pop()
        if (open.length === 0) {
          return index + 1
        }
      }
    }
  }
  return null
}

function countLines(lines) {
  const counts = new Map()
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

/** Multiset difference against the base — not an LCS diff: a moved line is one removal + one add. */
export function lineDelta(baseLines, sideLines) {
  const base = countLines(baseLines)
  const side = countLines(sideLines)
  let added = 0
  let removed = 0
  for (const [line, count] of side) {
    added += Math.max(0, count - (base.get(line) ?? 0))
  }
  for (const [line, count] of base) {
    removed += Math.max(0, count - (side.get(line) ?? 0))
  }
  return { added, removed }
}

/** Lines present in `sideLines` beyond the copies the base already had. */
function addedLines(baseLines, sideLines) {
  const remaining = countLines(baseLines)
  const added = []
  for (const line of sideLines) {
    const count = remaining.get(line) ?? 0
    if (count > 0) {
      remaining.set(line, count - 1)
    } else {
      added.push(line)
    }
  }
  return added
}

// Only indented lines count as members, which keeps duplicate-members quiet on `const x = 1` lines.
const MEMBER_COLON = /^\s+["'`]?([A-Za-z_$][\w$-]*)["'`]?\s*:/
const MEMBER_ASSIGN = /^\s+["'`]?([A-Za-z_$][\w$-]*)["'`]?\s*=\s*\S/
// Map-like additions, and one-per-line union/list members, which carry their own marker so a bare
// quoted line (a directive, a lone string) is not read as a member.
const MEMBER_SET = /^\s*[\w$.?]+\.set\(\s*["'`]?([A-Za-z_$][\w$.-]*)["'`]?\s*,/
const MEMBER_UNION_PIPED = /^\s*\|\s*["'`]([A-Za-z_$][\w$.-]*)["'`]/
const MEMBER_UNION_LISTED = /^\s*["'`]([A-Za-z_$][\w$.-]*)["'`]\s*[|,]/
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g
const STRING_LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g

function memberKey(line) {
  const match =
    MEMBER_COLON.exec(line.replace(/,\s*$/, '')) ??
    MEMBER_ASSIGN.exec(line) ??
    MEMBER_SET.exec(line) ??
    MEMBER_UNION_PIPED.exec(line) ??
    MEMBER_UNION_LISTED.exec(line)
  return match ? match[1] : null
}

/** String contents masked, identifiers intact: equal means the same tokens, possibly other values. */
function stringShape(lines) {
  return lines.map((line) => line.replace(STRING_LITERAL, '"')).join('\n')
}

/** Identifiers masked too, so only non-token text must match. */
function strictShape(lines) {
  return stringShape(lines).replace(IDENTIFIER, '#')
}

/** Identifier tokens differ while everything else, string contents included, is identical. */
function isRenameReplay(ours, theirs) {
  return strictShape(ours) === strictShape(theirs) && stringShape(ours) !== stringShape(theirs)
}

function intersect(left, right) {
  const rightSet = new Set(right)
  return [...new Set(left.filter((value) => rightSet.has(value)))]
}

function firstDiff(ours, theirs, startLine) {
  const length = Math.max(ours.length, theirs.length)
  for (let index = 0; index < length; index += 1) {
    if (ours[index] !== theirs[index]) {
      const line = startLine + index + 1
      return { line, ours: ours[index] ?? null, theirs: theirs[index] ?? null }
    }
  }
  return null
}

export function classifyHunk(hunk, index = 0) {
  const ours = hunk.ours
  const theirs = hunk.theirs
  const tail = hunk.tail ?? []
  const base = hunk.base ?? []
  const stack = { ours: openers(ours), theirs: openers(theirs) }
  const balance = { ours: delimiterBalance(ours), theirs: delimiterBalance(theirs) }
  const closesOurs = closesAt(tail, stack.ours)
  const closesTheirs = closesAt(tail, stack.theirs)
  const balanced = balance.ours === 0 && balance.theirs === 0
  const delta = { ours: lineDelta(base, ours), theirs: lineDelta(base, theirs) }
  const added = { ours: addedLines(base, ours), theirs: addedLines(base, theirs) }
  const members = (side) => added[side].map(memberKey).filter(Boolean)
  const sharedMembers = intersect(members('ours'), members('theirs'))
  const additionOverlap = intersect(added.ours, added.theirs).length
  // At least one unbalanced side is the ONLY case where duplicating the shared tail can be right;
  // when both sides are balanced the tail must not be duplicated.
  const duplicateFor = [closesOurs ? 'ours' : null, closesTheirs ? 'theirs' : null].filter(Boolean)
  // A competing replacement (`return f(` against `return g(`) is not a tail duplication: both sides
  // have to open the same expression for the shared tail to belong to either one.
  const sharesOpenPrefix = delimiterBalance(commonPrefix(ours, theirs)) > 0
  let state = { class: 'inconclusive', reason: REASON.empty }
  if (ours.length > 0 || theirs.length > 0) {
    if (balanced && isRenameReplay(ours, theirs)) {
      state = { class: 'rename-replay', reason: REASON.rename }
    } else if (balanced && delta.ours.removed > 0 && delta.theirs.removed > 0) {
      state = { class: 'both-rewrote', reason: REASON.bothChanged }
    } else if (balanced && sharedMembers.length > 0) {
      state = { class: 'duplicate-members', reason: `${REASON.dedup}: ${sharedMembers.join(', ')}` }
    } else if (balanced && additionOverlap > 0) {
      state = { class: 'both-rewrote', reason: REASON.overlap }
    } else if (balanced) {
      state = { class: 'union', reason: REASON.union }
    } else if (duplicateFor.length > 0 && sharesOpenPrefix) {
      state = { class: 'duplicate-tail', reason: REASON.tail, duplicateFor }
    } else if (duplicateFor.length > 0) {
      state = { class: 'both-rewrote', reason: REASON.divergingTail, duplicateFor: [] }
    } else {
      state = { class: 'both-rewrote', reason: REASON.unbalanced }
    }
  }
  return {
    index,
    startLine: hunk.startLine,
    endLine: hunk.endLine,
    labels: { ours: hunk.oursLabel ?? '', theirs: hunk.theirsLabel ?? '' },
    ours,
    theirs,
    base,
    basePresent: hunk.base !== null,
    tail,
    balance,
    delta,
    firstDiff: firstDiff(ours, theirs, hunk.startLine),
    additionOverlap,
    sharedMembers,
    sharesOpenPrefix,
    tailCloses: { ours: closesOurs, theirs: closesTheirs },
    duplicateFor: [],
    ...state
  }
}

function pickSevere(hunks) {
  let winner = null
  for (const hunk of hunks) {
    if (winner === null || SEVERITY[hunk.class] > SEVERITY[winner]) {
      winner = hunk.class
    }
  }
  return winner
}

export function classifyFile({
  path,
  status = null,
  base = null,
  ours = null,
  theirs = null,
  merged = null
}) {
  const parsed = merged === null || merged.includes('\u0000') ? [] : parseConflictHunks(merged)
  const hunks = parsed.map((hunk, index) => classifyHunk(hunk, index + 1))
  const hunkClasses = hunks.map((hunk) => hunk.class)
  const statusClass = status === null ? null : (STATUS_CLASSES[status] ?? null)
  const noBase = hunks.length > 0 && !hunks.every((hunk) => hunk.basePresent)
  const notes = []
  if (merged === null) {
    notes.push('merged content unavailable — names, status and counts only')
  } else if (merged.includes('\u0000')) {
    notes.push('binary merged content — no marker classification')
  } else if (hunks.length === 0) {
    notes.push('no conflict markers in the merged content')
  }
  if (noBase) {
    notes.push(
      'hunks have no `|||||||` base — counts are side-to-side (merge.conflictStyle=zdiff3 gives it)'
    )
  }
  if (ours === null || theirs === null) {
    notes.push(`stage missing: ${ours === null ? 'ours' : 'theirs'} — see the status code`)
  }
  return {
    path,
    status,
    statusLabel: status === null ? null : (UNMERGED_STATUS[status] ?? 'unmerged'),
    class: statusClass ?? pickSevere(hunks) ?? (merged === null ? 'unknown' : 'no-markers'),
    classes: [...new Set([statusClass, ...hunkClasses].filter(Boolean))],
    sides: { base: base !== null, ours: ours !== null, theirs: theirs !== null },
    hunkCount: hunks.length,
    hunkClasses,
    hunks,
    notes
  }
}

// ------------------------------------------------------------------ convergence ledger

const LEDGER_FIELDS = {
  Paths: 'paths',
  Decision: 'decision',
  Why: 'why',
  'Do not': 'doNot',
  Tooling: 'tooling'
}

// Commas outside `{a,b}` alternation separate globs; inside, they are part of one glob.
function globList(text) {
  const entries = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth = Math.max(0, depth - 1)
    }
    if (character === ',' && depth === 0) {
      entries.push(current)
      current = ''
      continue
    }
    current += character
  }
  entries.push(current)
  return entries.map((entry) => entry.replace(/`/g, '').trim()).filter(Boolean)
}

/** Tolerant ledger reader: a malformed section must never stop a conflict triage. */
export function parseLedger(markdown) {
  const sections = []
  let section = null
  let field = null
  for (const row of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(row)
    if (heading) {
      section = {
        title: heading[1].trim(),
        paths: [],
        decision: [],
        why: [],
        doNot: [],
        tooling: []
      }
      sections.push(section)
      field = null
      continue
    }
    if (section === null || /^-{3,}\s*$/.test(row)) {
      field = null
      continue
    }
    const entry = /^\*\*(Paths|Decision|Why|Do not|Tooling):\*\*\s*(.*)$/.exec(row.trim())
    if (entry) {
      field = LEDGER_FIELDS[entry[1]]
      const value = entry[2].trim()
      if (value !== '') {
        if (field === 'paths') {
          section.paths.push(...globList(value))
        } else {
          section[field].push(value)
        }
      }
      continue
    }
    if (field === null) {
      continue
    }
    if (row.trim() === '') {
      field = null
      continue
    }
    if (field === 'paths') {
      section.paths.push(...globList(row.trim()))
    } else {
      section[field].push(row.trim())
    }
  }
  return sections
}

function expandBraces(glob) {
  const match = /\{([^{}]*)\}/.exec(glob)
  if (match === null) {
    return [glob]
  }
  const head = glob.slice(0, match.index)
  const rest = glob.slice(match.index + match[0].length)
  return match[1].split(',').flatMap((alternative) => expandBraces(head + alternative + rest))
}

function globToRegex(glob) {
  // Sentinels keep the two `**` forms apart while every other metacharacter is escaped.
  return glob
    .replace(/\*\*\//g, '@@ds@@')
    .replace(/\*\*/g, '@@star@@')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/@@ds@@/g, '(?:.*/)?')
    .replace(/@@star@@/g, '.*')
}

/** Glob match with `**`, `*`, `?` and `{a,b}`, anchored to the whole path. */
export function globMatches(glob, path) {
  return expandBraces(glob).some((expanded) => new RegExp(`^${globToRegex(expanded)}$`).test(path))
}

export function ledgerMatches(sections, path) {
  return sections.filter((section) => section.paths.some((glob) => globMatches(glob, path)))
}
