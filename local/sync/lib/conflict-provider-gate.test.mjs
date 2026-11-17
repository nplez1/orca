// Fixture tests for the re-pointed-import check and the git plumbing under it. Only the catFileBatch
// test runs git, read-only, against this repository's HEAD:
//   node --test local/sync/lib/conflict-provider-gate.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { catFileBatch, gitProviderHistory, parseRenames, parseTree } from './conflict-index.mjs'
import { providerHistory, swappedProviders } from './conflict-provider-gate.mjs'
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
  edited = null,
  oldPath = 'status.ts',
  oursAdds = {},
  historyFor = historyOf
}) => {
  const sides = { base: file(importLine), ours: file(importLine), theirs: file(newLine) }
  const baseTree = { [at(oldPath)]: oldModule, ...deps }
  const oursTree = {
    ...baseTree,
    ...(edited ? { [edited]: `${String(baseTree[edited])}// fork edit\n` } : {}),
    ...oursAdds
  }
  const history = historyFor({
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
  // The other side's stage must be that side's copy of the old module, not just any blob.
  assert.equal(
    carriedWhen(
      new Map([
        ['1', oid('1')],
        ['2', oid('6')],
        ['3', oid('3')]
      ])
    ),
    false
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

const STATUS_RE_POINT = {
  importLine: "import type { Status } from './status'",
  newLine: "import type { Status } from './rollup'"
}

test('a re-point away from a workspace package refuses: its exports cannot be traced', () => {
  const found = rePointed({
    importLine: "import { X } from '@orca/foo'",
    newLine: "import { X } from './rollup'",
    oldModule: 'export const unused = 1\n'
  })
  assert.match(found.join(), /^X \(its old module @orca\/foo is a workspace package/)
  // A bare npm package is not the fork's to edit, so it is still skipped.
  assert.deepEqual(
    rePointed({
      importLine: "import { X } from 'react'",
      newLine: "import { X } from './rollup'",
      oldModule: ''
    }),
    []
  )
})

test('an old module whose closure cannot be traced refuses: a workspace import, a missing path, a broken parse', () => {
  for (const oldModule of [
    "export { run } from '@orca/process-host'\nexport type Status = 'a'\n",
    "export { gone } from './missing'\nexport type Status = 'a'\n",
    'export type Status = \n'
  ]) {
    const found = rePointed({ ...STATUS_RE_POINT, oldModule })
    assert.match(
      found.join(),
      /^Status \(what its old module .*status\.ts imports cannot be traced/,
      oldModule
    )
  }
})

test('the other side resolving an edge to another file is a change, though no byte moved', () => {
  // Base's `./types` is types/index.ts; the fork adds types.ts, which TypeScript probes first.
  const found = rePointed({
    ...STATUS_RE_POINT,
    oldModule: "export type { Status } from './types'\n",
    deps: { [at('types/index.ts')]: "export type Status = 'a'\n" },
    oursAdds: { [at('types.ts')]: "export type Status = 'a' | 'b'\n" }
  })
  assert.match(found.join(), /status\.ts -> \.\/types/)
  // The control: nothing edited and nothing shadowed passes.
  assert.deepEqual(
    rePointed({
      ...STATUS_RE_POINT,
      oldModule: "export type { Status } from './types'\n",
      deps: { [at('types/index.ts')]: "export type Status = 'a'\n" }
    }),
    []
  )
})

test('production compares blob oids, and a bulk read that returns nothing falls back to read', () => {
  // The Map shape gitProviderHistory builds: path -> oid. Text is still read for parsing the closure.
  const byOid = (oursOid) => ({ base: oldOid, ours: oursOid, theirs: oldOid })
  const oldOid = 'a'.repeat(40)
  const history =
    (oids, prefetch, text = "export type Status = 'a'\n") =>
    () =>
      providerHistory({
        files: {
          base: new Map([[at('status.ts'), oids.base]]),
          ours: new Map([[at('status.ts'), oids.ours]]),
          theirs: new Map([
            [at('status.ts'), oids.theirs],
            [at('rollup.ts'), 'f'.repeat(40)]
          ])
        },
        read: () => text,
        renames: {},
        prefetch
      })
  const run = (historyFor) =>
    rePointed({ ...STATUS_RE_POINT, oldModule: "export type Status = 'a'\n", historyFor })
  // Same text, different blob: an oid comparison sees the change a text one would not.
  assert.match(run(history(byOid('b'.repeat(40)))).join(), /^Status .*ours changed .*status\.ts/)
  assert.deepEqual(run(history(byOid(oldOid), () => new Map())), [])
  // The bulk read returned nothing, so the text that makes the closure untraceable came from `read`.
  const missing = "export { gone } from './missing'\n"
  assert.match(
    run(history(byOid('b'.repeat(40)), () => new Map(), missing)).join(),
    /imports cannot be traced/
  )
})

test('catFileBatch reads several blobs in one process and leaves out what it cannot frame', () => {
  const texts = catFileBatch('HEAD', [
    'package.json',
    'no/such/file',
    'a\nb',
    'local/sync/README.md'
  ])
  assert.deepEqual([...texts.keys()], ['package.json', 'local/sync/README.md'])
  assert.match(texts.get('package.json'), /"name"/)
})

// `export { x } from`, `export * as ns from` and `import x = require()` carry a binding exactly as an
// import does, and `export * from` carries a module with no name of its own. Before this, all four were
// invisible to the check: `importSources` read static import declarations only, so a re-export re-point
// kept upstream's edit out and nothing noticed.
test('a re-export or an `import = require` re-point is refused when the other side changed the old module', () => {
  for (const [baseLine, newLine, pattern] of [
    [
      "export { Status } from './status'",
      "export { Status } from './rollup'",
      /export Status .*ours changed/
    ],
    ["export * as S from './status'", "export * as S from './rollup'", /export S .*ours changed/],
    ["import S = require('./status')", "import S = require('./rollup')", /^S .*ours changed/],
    ["export * from './status'", "export * from './rollup'", /^\.\/status \(no longer referenced/]
  ]) {
    const found = rePointed({
      importLine: baseLine,
      newLine,
      oldModule: "export type Status = 'a'\n",
      edited: at('status.ts')
    })
    assert.match(found.join(), pattern, baseLine)
  }
})

/**
 * A conflict at `path` (the post-merge home of a moved importer), with each side's own tree beside it.
 * `carried` is what the index holds the merge's own result of.
 */
const movedImporter = ({
  path,
  basePath,
  baseLine,
  oursLine,
  theirsLine = baseLine,
  resolvedLine = oursLine,
  sides,
  renames,
  carried = []
}) => {
  const parse = (text) => parseSource(path, text).sf
  return swappedProviders({
    path,
    resolvedSf: parse(resolvedLine),
    sides: { base: parse(baseLine), ours: parse(oursLine), theirs: parse(theirsLine) },
    history: historyOf(
      {
        base: { [basePath]: `${baseLine}\n`, ...sides.base },
        ours: { [basePath]: `${oursLine}\n`, ...sides.ours },
        theirs: { [path]: `${theirsLine}\n`, ...sides.theirs }
      },
      renames,
      carried
    )
  })
}

test('a same-text specifier is refused when the importer’s own move re-means it', () => {
  // `./status` names `a/status.ts` next to base's `a/foo.ts`; at the new home it names `b/status.ts`.
  const found = movedImporter({
    path: 'src/b/foo.ts',
    basePath: 'src/a/foo.ts',
    baseLine: "import { S } from './status'",
    oursLine: "import { S } from './status'\nconst fork = 1",
    sides: {
      base: { 'src/a/status.ts': 'export const S = 1\n' },
      ours: { 'src/a/status.ts': 'export const S = 1\nconst FORK = 2\n' },
      theirs: { 'src/b/status.ts': 'export const S = 9\n' }
    },
    renames: { theirs: [['src/a/foo.ts', 'src/b/foo.ts']] }
  })
  assert.match(found.join(), /^S \(now from src\/b\/status\.ts; ours changed src\/a\/status\.ts/)
  // The side that moved the importer is the one whose layout counts, so an old module the *fork* edited
  // is the one to compare: upstream keeping it byte-identical must still refuse.
  const kept = movedImporter({
    path: 'src/b/foo.ts',
    basePath: 'src/a/foo.ts',
    baseLine: "import { S } from './status'",
    oursLine: "import { S } from './status'\nconst fork = 1",
    sides: {
      base: { 'src/a/status.ts': 'export const S = 1\n' },
      ours: { 'src/a/status.ts': 'export const S = 1\nconst FORK = 2\n' },
      theirs: {
        'src/a/status.ts': 'export const S = 1\n',
        'src/b/status.ts': 'export const S = 9\n'
      }
    },
    renames: { theirs: [['src/a/foo.ts', 'src/b/foo.ts']] }
  })
  assert.match(kept.join(), /^S \(now from src\/b\/status\.ts; ours changed src\/a\/status\.ts/)
})

test('a move the merge carried is refused when the moved copy’s own import re-means', () => {
  // Upstream moved `a/m.ts` to `b/m.ts` and left `a/types.ts` behind: the moved copy still says
  // `./types`, which from its new home names a file the merge does not keep.
  const moved = {
    path: 'src/lib/use.ts',
    basePath: 'src/x/use.ts',
    baseLine: "import { S } from './m'",
    oursLine: "import { S } from './m'\nconst fork = 1",
    sides: {
      base: {
        'src/x/m.ts': "export type { S } from './types'\n",
        'src/x/types.ts': 'export type S = 1\n'
      },
      ours: { 'src/x/types.ts': 'export type S = 1 | 2\n' },
      theirs: { 'src/lib/m.ts': "export type { S } from './types'\n" }
    },
    renames: {
      theirs: [
        ['src/x/use.ts', 'src/lib/use.ts'],
        ['src/x/m.ts', 'src/lib/m.ts']
      ]
    },
    carried: ['src/lib/m.ts']
  }
  // Both shapes refuse, and both through the moved copy's imports: base's own text, and the rewrite a
  // move usually brings with it. (Before the attribution fix, the first fell through to the closure and
  // refused for the wrong reason, which also made the whole-directory test below pass by accident.)
  assert.match(movedImporter(moved).join(), /moved copy's \.\/types changed meaning/)
  assert.match(
    movedImporter({
      ...moved,
      theirsLine: "import { S } from './m.ts'",
      resolvedLine: "import { S } from './m.ts'"
    }).join(),
    /moved copy's \.\/types changed meaning/
  )
  // An import the other side added to the old module is carried into the moved copy, where it re-means
  // the same way: here it resolves to nothing at all.
  const added = {
    ...moved,
    sides: {
      ...moved.sides,
      theirs: { 'src/lib/m.ts': "export type { S } from './types'\nimport './extra'\n" }
    }
  }
  assert.match(
    movedImporter({
      ...added,
      theirsLine: "import { S } from './m.ts'",
      resolvedLine: "import { S } from './m.ts'"
    }).join(),
    /\.\/extra \(added, and it resolves to nothing from the move\)/
  )
})

test('a move the merge carried still passes when the whole directory moved', () => {
  const moved = {
    path: 'src/lib/use.ts',
    basePath: 'src/x/use.ts',
    baseLine: "import { S } from './m'",
    oursLine: "import { S } from './m'\nconst fork = 1",
    sides: {
      base: {
        'src/x/m.ts': "export type { S } from './types'\n",
        'src/x/types.ts': 'export type S = 1\n'
      },
      ours: { 'src/x/types.ts': 'export type S = 1 | 2\n' },
      theirs: {
        'src/lib/m.ts': "export type { S } from './types'\n",
        'src/lib/types.ts': 'export type S = 1\n'
      }
    },
    renames: {
      theirs: [
        ['src/x/use.ts', 'src/lib/use.ts'],
        ['src/x/m.ts', 'src/lib/m.ts'],
        ['src/x/types.ts', 'src/lib/types.ts']
      ]
    },
    carried: ['src/lib/m.ts']
  }
  assert.deepEqual(movedImporter(moved), [])
  // It passes on the merge's pairing proof, not by accident: without it the closure refuses.
  assert.match(
    movedImporter({ ...moved, carried: [] }).join(),
    /^S \(now from src\/lib\/m\.ts; ours changed/
  )
})

test('an unchanged workspace import survives a move to another project, a mobile alias does not', () => {
  const path = 'src/renderer/src/lib/b/thing.ts'
  const line = "import { p } from '@orca/process-host'\n"
  const parse = (text) => parseSource(path, text).sf
  const found = swappedProviders({
    path,
    resolvedSf: parse(line),
    sides: { base: parse(line), ours: parse(line), theirs: parse(line) },
    history: historyOf(
      { base: { 'src/lib/b/thing.ts': line }, ours: {}, theirs: { [path]: line } },
      { theirs: [['src/lib/b/thing.ts', path]] }
    )
  })
  assert.deepEqual(found, [])
})

test('an unchanged reference is left alone: an alias or a workspace package cannot re-mean', () => {
  const parse = (text) => parseSource('src/renderer/src/lib/a/thing.ts', text).sf
  const line =
    "import '@orca/foo/register'\nimport '@orca/test-mobile/phone'\nimport './styles.css'\nimport '@/store'\n"
  assert.deepEqual(
    swappedProviders({
      path: 'src/renderer/src/lib/a/thing.ts',
      resolvedSf: parse(line),
      sides: { base: parse(line), ours: parse(line), theirs: parse(line) },
      // A history that resolves nothing: unchanged text must not be resolved at all.
      history: historyOf({ base: {}, ours: {}, theirs: {} })
    }),
    []
  )
})
