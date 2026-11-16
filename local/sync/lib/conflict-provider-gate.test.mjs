// Fixture tests for the re-pointed-import check and the git plumbing under it. No git:
//   node --test local/sync/lib/conflict-provider-gate.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { gitProviderHistory, parseRenames, parseTree } from './conflict-index.mjs'
import { swappedProviders } from './conflict-provider-gate.mjs'
import {
  everyModule,
  file,
  historyOf,
  hunk,
  proveWithIndex,
  stagesOf
} from './conflict-test-fixtures.mjs'
import { parseSource } from './ts-source.mjs'

const CARD = 'src/renderer/src/card.tsx'
const at = (name) => `src/renderer/src/${name}`

test('a binding re-pointed at another module is refused when the other side changed it in the old one', () => {
  // The 2026-11-15 WorktreeCardStatusSlot.tsx shape: upstream took `WorktreeStatus` from a rollup module,
  // while the fork added 'setup' to the renderer's own `WorktreeStatus`, which upstream merely moved.
  const merged = file(
    hunk({
      ours: ["import { label, type Status } from './status'"],
      base: ["import { label, type Status } from './status'"],
      theirs: [
        "import { label } from './activity/status'",
        "import type { Status } from './rollup'"
      ]
    })
  )
  const before = "export type Status = 'a' | 'b'\nexport const label = 1\n"
  const forked = "export type Status = 'a' | 'b' | 'setup'\nexport const label = 1\n"
  const history = (oursStatus, carried) =>
    historyOf(
      {
        base: { [at('status.ts')]: before },
        ours: { [at('status.ts')]: oursStatus },
        theirs: {
          [at('activity/status.ts')]: before,
          [at('rollup.ts')]: "export type Status = 'a' | 'b'\n"
        }
      },
      { theirs: [[at('status.ts'), at('activity/status.ts')]] },
      carried
    )
  const prove = (history) =>
    proveWithIndex(CARD, merged, { exists: everyModule, history }, stagesOf(merged))
  // `label` followed its module's move and the merge carried the fork's edit there; `Status` did not.
  const swapped = prove(history(forked, [at('activity/status.ts')]))
  assert.equal(swapped.provenHunks, 1)
  assert.match(swapped.reason, /never reached: Status \(now from src\/renderer\/src\/rollup\.ts/)
  assert.doesNotMatch(swapped.reason, /label/)
  // The same move the merge cannot be shown to have carried refuses `label` as well.
  assert.match(prove(history(forked, [])).reason, /never reached: label .*Status/)
  // With no fork edit anywhere in the old module, upstream's choice of provider stands.
  assert.equal(prove(history(before, [])).fullyProven, true)
  // No history to trace the old module through refuses the re-pointed names rather than passing them.
  assert.equal(proveWithIndex(CARD, merged, everyModule, stagesOf(merged)).fullyProven, false)
})

// The shapes a declaration-level comparison let through: each has the fork's edit somewhere the
// binding's own declaration text does not show. `oldModule` is base's (and the fork's) ./status, `deps`
// what it imports; the fork edits `edited`; upstream re-points the import at ./rollup.
const rePointed = ({
  importLine,
  newLine,
  oldModule,
  deps = {},
  edited,
  oldPath = 'status.ts'
}) => {
  const sides = { base: file(importLine), ours: file(importLine), theirs: file(newLine) }
  const baseTree = { [at(oldPath)]: oldModule, ...deps }
  const oursTree = { ...baseTree, [edited]: `${baseTree[edited]}// fork edit\n` }
  const history = historyOf({
    base: baseTree,
    ours: oursTree,
    theirs: { ...baseTree, [at('rollup.ts')]: 'export type Status = 1\n' }
  })
  const parse = (text) => parseSource(CARD, text).sf
  return swappedProviders({
    path: CARD,
    resolvedSf: parse(sides.theirs),
    sides: { base: parse(sides.base), ours: parse(sides.ours), theirs: parse(sides.theirs) },
    history
  })
}

test('a re-point is refused when the fork edited what the old module only re-exports', () => {
  const types = { [at('types.ts')]: "export type Status = 'a'\n" }
  for (const oldModule of [
    "export type { Status } from './types'\n",
    "export * from './types'\n",
    "import type { Status } from './types'\nexport type { Status }\n"
  ]) {
    const found = rePointed({
      importLine: "import type { Status } from './status'",
      newLine: "import type { Status } from './rollup'",
      oldModule,
      deps: types,
      edited: at('types.ts')
    })
    assert.match(found.join(), /Status .*ours changed .*types\.ts/, oldModule)
  }
})

test('a re-point is refused for an aliased, default or namespace import of an edited module', () => {
  const oldModule = "export type Status = 'a'\nexport default 1\n"
  for (const [importLine, newLine] of [
    ["import type { Status as S } from './status'", "import type { Status as S } from './rollup'"],
    ["import S from './status'", "import S from './rollup'"],
    ["import * as S from './status'", "import * as S from './rollup'"]
  ]) {
    const found = rePointed({ importLine, newLine, oldModule, edited: at('status.ts') })
    assert.match(found.join(), /^S \(now from .*rollup\.ts; ours changed/, importLine)
  }
})

test('a re-point is refused when the fork edited a non-script module or a dependency of the old one', () => {
  const css = rePointed({
    importLine: "import styles from './card.module.css'",
    newLine: "import styles from './rollup'",
    oldModule: '.card { color: red }\n',
    oldPath: 'card.module.css',
    edited: at('card.module.css')
  })
  assert.match(css.join(), /^styles .*card\.module\.css/)
  const dependency = rePointed({
    importLine: "import type { Status } from './status'",
    newLine: "import type { Status } from './rollup'",
    oldModule: "import type { Base } from './base'\nexport type Status = Base | 'x'\n",
    deps: { [at('base.ts')]: "export type Base = 'a'\n" },
    edited: at('base.ts')
  })
  assert.match(dependency.join(), /^Status .*base\.ts/)
})

test('git plumbing: -z renames and trees parse, and a move is carried only on the merge’s own result', () => {
  assert.deepEqual(
    [...parseRenames('R100\u0000a/old.ts\u0000b/new.ts\u0000R071\u0000c d.ts\u0000e.ts\u0000')],
    [
      ['a/old.ts', 'b/new.ts'],
      ['c d.ts', 'e.ts']
    ]
  )
  assert.deepEqual(
    [
      ...parseTree(
        `100644 blob ${'1'.repeat(40)}\tsrc/a b.ts\u0000040000 tree ${'2'.repeat(40)}\tsrc\u0000`
      )
    ],
    [['src/a b.ts', '1'.repeat(40)]]
  )
  const oid = (digit) => digit.repeat(40)
  const trees = {
    B: `100644 blob ${oid('1')}\told.ts`,
    O: `100644 blob ${oid('2')}\told.ts`,
    T: `100644 blob ${oid('3')}\tnew.ts`
  }
  const answers = {
    'ls-tree': (args) => trees[args.at(-1)],
    diff: (args) => (args.at(-1) === 'T' ? 'R090\u0000old.ts\u0000new.ts\u0000' : ''),
    'merge-file': () => oid('9')
  }
  const gitText = (args) => answers[args[0]]?.(args) ?? null
  const carriedWhen = (held) =>
    gitProviderHistory(gitText, { base: 'B', ours: 'O', theirs: 'T' }, () => held).carries({
      now: 'new.ts',
      old: 'old.ts',
      other: 'ours',
      taker: 'theirs'
    })
  assert.equal(
    carriedWhen(
      new Map([
        ['1', oid('1')],
        ['2', oid('2')],
        ['3', oid('3')]
      ])
    ),
    true
  )
  // A conflict whose base stage is some other file is not this move.
  assert.equal(
    carriedWhen(
      new Map([
        ['1', oid('7')],
        ['2', oid('2')],
        ['3', oid('3')]
      ])
    ),
    false
  )
  assert.equal(carriedWhen(new Map([['0', oid('9')]])), true)
  assert.equal(carriedWhen(new Map([['0', oid('8')]])), false)
  assert.equal(carriedWhen(null), false)
})
