// Upstream's `max-lines` ratchet reports a new bypass and expects a human to allow it. The fork's rule
// (LOCAL-PATCHES.md § local(lint)) is narrower: only an upstream-owned file may be exempted, because
// splitting one costs a permanent hunk on every sync, while the fork's own files must be split. That half
// is checkable, so it is checked here rather than left to a reviewer's memory.
//
// The comparison is against the *recorded sync base*, never a ref tip and never `origin/HEAD` — see
// `lib/upstream-sync-base.mjs` for why. There is no skip: a check that cannot resolve the base fails and
// names the command that fixes it, because a policy check that skips is not a policy check.
//
// The tool that writes both halves of an exemption is pinned below at its pure seams: a rerun must
// duplicate neither half, and the row must land in the sorted position the ratchet rewrites to.
//
//   node --test local/max-lines-exemption.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  countCodeLines,
  exemptionHeader,
  insertBaselineRow,
  maxLinesReason,
  withExemptionHeader
} from './max-lines-exemption.mjs'
import {
  commitExists,
  commitHasPath,
  fetchCommandFor,
  readRecordedSyncBase
} from './lib/upstream-sync-base.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE = 'config/max-lines-baseline.txt'
const KINDS = new Set(['inline', 'mobile-config'])

function parseBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [kind, file] = line.split(/\s+/)
      return { kind, path: file }
    })
}

// Recorded exceptions to the split rule above, each a fork-owned file that was already over budget and
// carries its own `-- Why:` header. The owner chose to ship these as exemptions on 2026-11-26 rather
// than split two single-closure factories under release pressure; each entry must be split or re-justified
// at the next sync (LOCAL-PATCHES.md § local(lint)). Adding a path here is a policy change, not a fix.
const FORK_OWNED_EXCEPTIONS = new Map([
  [
    'src/main/host-mesh/host-mesh-driver.ts',
    'one cohesive protocol state machine: the driver, its catch-up and its delivery all read one closure'
  ],
  [
    'src/main/host-mesh/host-mesh-rpc-service.ts',
    'the peer-facing half of the same closure; splitting it would separate a request from its handler state'
  ]
])

const entries = parseBaseline(readFileSync(path.join(ROOT, BASELINE), 'utf8'))
const base = readRecordedSyncBase(ROOT)
const baseProblem = base
  ? commitExists(ROOT, base)
    ? null
    : `the recorded sync base ${base} is not in this clone: ${fetchCommandFor(base)}`
  : `no sync base is recorded in local/upstream-file-comments-baseline.json — regenerate it with ` +
    '`node local/check-upstream-file-comments.mjs --init --accept "<why>"`'

test('the upstream sync base is recorded and present, so the rule below can be judged', () => {
  assert.equal(baseProblem, null)
})

test('parses every row into a known kind and a path', () => {
  assert.ok(entries.length > 0)
  for (const entry of entries) {
    assert.ok(KINDS.has(entry.kind), `unknown kind in: ${entry.kind} ${entry.path}`)
    assert.ok(entry.path, `row without a path: ${entry.kind}`)
  }
})

test('names files that exist in this tree, so a renamed file cannot leave a stale row', () => {
  for (const entry of entries) {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', entry.path], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    assert.equal(tracked.trim(), entry.path)
  }
})

test('exempts only upstream-owned files (the recorded sync base is upstream)', () => {
  assert.equal(baseProblem, null, 'cannot judge upstream ownership without the recorded sync base')
  const forkOwned = entries.filter(
    (entry) => !commitHasPath(ROOT, base, entry.path) && !FORK_OWNED_EXCEPTIONS.has(entry.path)
  )
  assert.deepEqual(
    forkOwned.map((entry) => entry.path),
    [],
    'a fork-owned file over the max-lines budget must be split, not exempted: it has no upstream ' +
      'copy to conflict with, so the cap is a free guard there (LOCAL-PATCHES.md § local(lint)). ' +
      'If the file IS upstream-owned, the recorded sync base is older than this sync — re-run ' +
      '`node local/check-upstream-file-comments.mjs --init --accept "<why>"` to move it forward'
  )
})

test('a recorded fork-owned exception states its own reason in the file', () => {
  for (const [file, why] of FORK_OWNED_EXCEPTIONS) {
    const row = entries.find((entry) => entry.path === file)
    assert.ok(row, `${file} is a recorded exception with no baseline row`)
    const reason = maxLinesReason(readFileSync(path.join(ROOT, file), 'utf8'))
    assert.ok(reason && reason.trim() !== '', `${file} states no -- Why: in its max-lines header`)
    assert.ok(
      why.trim() !== '',
      `${file} is allowed as an exception in the test but says nothing about why it cannot be split`
    )
  }
})

test('counts non-blank, non-comment lines, as the oxlint rule does', () => {
  const source = [
    '// a line comment',
    '',
    '/* a block',
    '   comment */',
    'export const a = 1',
    '   ',
    'export const b = 2 // trailing'
  ].join('\n')
  assert.equal(countCodeLines(source), 2)
})

// Why assembled: the max-lines ratchet reads source text, so a contiguous disable directive in a
// fixture is counted as a new exemption for this file and fails the changed-code gate.
const MAX_LINES_DISABLE = '/* eslint' + '-disable max-lines'

test('writes the header once, above a shebang and never twice', () => {
  const header = exemptionHeader('upstream-owned and at its budget.')
  assert.equal(
    withExemptionHeader('export const a = 1\n', 'upstream-owned and at its budget.'),
    `${header}\nexport const a = 1\n`
  )
  assert.equal(
    withExemptionHeader('#!/usr/bin/env node\nexport const a = 1\n', 'why'),
    `#!/usr/bin/env node\n${exemptionHeader('why')}\nexport const a = 1\n`
  )
  const once = withExemptionHeader('export const a = 1\n', 'why')
  assert.equal(withExemptionHeader(once, 'a different reason'), once)
  assert.equal(
    exemptionHeader('why\nover two lines.'),
    `${MAX_LINES_DISABLE} -- Why: why over two lines. */`
  )
})

test('adds the baseline row in sorted position and never duplicates it', () => {
  const baseline = '# a header\n# second line\ninline src/a.ts\ninline src/z.ts\n'
  const added = insertBaselineRow(baseline, 'inline src/m.ts')
  assert.equal(
    added,
    '# a header\n# second line\ninline src/a.ts\ninline src/m.ts\ninline src/z.ts\n'
  )
  assert.equal(insertBaselineRow(added, 'inline src/m.ts'), added)
})

test('reads the recorded reason out of a file, and null when it has none', () => {
  assert.equal(
    maxLinesReason(`${MAX_LINES_DISABLE} -- Why: splitting costs a sync hunk. */\n`),
    'splitting costs a sync hunk.'
  )
  assert.equal(
    maxLinesReason(`${MAX_LINES_DISABLE} -- Why: it wraps,\n   so the reason does too. */\n`),
    'it wraps, so the reason does too.'
  )
  assert.equal(maxLinesReason('// eslint-disable-next-line no-console\n'), null)
  assert.equal(maxLinesReason('export const a = 1\n'), null)
})
