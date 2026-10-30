import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectAddedCommentLines,
  evaluate,
  isCommentLine,
  main,
  parseArgs
} from '../../local/check-upstream-file-comments.mjs'

const DIFF = [
  'diff --git a/src/main/owned.ts b/src/main/owned.ts',
  'index 111..222 100644',
  '--- a/src/main/owned.ts',
  '+++ b/src/main/owned.ts',
  '@@ -1,3 +1,8 @@',
  ' const kept = 1',
  '+// Why this exists: a rationale above upstream code.',
  '+const value = 2',
  '+/* Block opener',
  '+ * continued',
  '+ */',
  '-// removed upstream comment',
  '@@ -10,2 +15,3 @@',
  '+// eslint-disable max-lines -- Why: the registry is one list',
  '+const other = 3',
  'diff --git a/src/shared/added.ts b/src/shared/added.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/shared/added.ts',
  '@@ -0,0 +1,2 @@',
  '+// a fork file nobody upstream owns',
  '+export const fromFork = true'
].join('\n')

const tempDirs = []

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'upstream-file-comments-'))
  tempDirs.push(root)
  const run = (...args) =>
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], {
      cwd: root,
      encoding: 'utf8'
    })
  run('init', '--quiet')
  return { root, run }
}

function commit(run, message) {
  run('add', '--all')
  run('commit', '--quiet', '-m', message)
  return run('rev-parse', 'HEAD').trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('isCommentLine', () => {
  it('recognises the comment shapes a fork delta adds', () => {
    expect(isCommentLine('// x')).toBe(true)
    expect(isCommentLine('  /* x')).toBe(true)
    expect(isCommentLine('   * x')).toBe(true)
    expect(isCommentLine('<!-- x')).toBe(true)
    expect(isCommentLine('const x = 1 // trailing')).toBe(false)
    expect(isCommentLine('*/')).toBe(false)
  })
})

describe('collectAddedCommentLines', () => {
  it('counts only added comment lines, per modified file', () => {
    const counts = collectAddedCommentLines(DIFF)
    // The rationale plus both counted lines of the block; the closing `*/` is not a new comment.
    expect(counts.get('src/main/owned.ts')).toBe(3)
    expect(counts.has('src/shared/added.ts')).toBe(true)
  })

  it('skips the max-lines directive the lint rule mandates', () => {
    const diff = [
      'diff --git a/src/main/owned.ts b/src/main/owned.ts',
      '--- a/src/main/owned.ts',
      '+++ b/src/main/owned.ts',
      '@@ -1 +1,2 @@',
      '+// eslint-disable max-lines -- Why: one registry list',
      '+// ordinary rationale'
    ].join('\n')
    expect([...collectAddedCommentLines(diff).values()]).toEqual([1])
  })

  it('exempts a block marked fork-comment-ok up to the next hunk or code line', () => {
    const diff = [
      'diff --git a/src/main/owned.ts b/src/main/owned.ts',
      '--- a/src/main/owned.ts',
      '+++ b/src/main/owned.ts',
      '@@ -1 +1,4 @@',
      '+// fork-comment-ok: upstream has no other home for this',
      '+// first explanation',
      '+const value = 1',
      '+// after code, so counted again',
      '@@ -9 +9,2 @@',
      '+// a new hunk starts unmarked'
    ].join('\n')
    expect([...collectAddedCommentLines(diff).values()]).toEqual([2])
  })
  it('ends the exemption at a context line, so one marker cannot cover a whole hunk', () => {
    const diff = [
      'diff --git a/src/main/owned.ts b/src/main/owned.ts',
      '--- a/src/main/owned.ts',
      '+++ b/src/main/owned.ts',
      '@@ -1 +1,4 @@',
      '+// fork-comment-ok: this one must stay',
      ' const untouched = 1',
      '+// a later rationale the marker does not cover',
      '+// and its second line'
    ].join('\n')
    expect([...collectAddedCommentLines(diff).values()]).toEqual([2])
  })

  it('fails loudly when git prefixes paths unexpectedly instead of counting zero', () => {
    const diff = [
      'diff --git i/src/main/owned.ts w/src/main/owned.ts',
      '--- i/src/main/owned.ts',
      '+++ w/src/main/owned.ts',
      '@@ -1 +1,2 @@',
      '+// a rationale'
    ].join('\n')
    expect(() => collectAddedCommentLines(diff)).toThrow(/prefixing paths|parseable file header/)
  })

  it('counts `#` comments in a yaml file and JSX comments in a tsx file', () => {
    const diff = [
      'diff --git a/.github/workflows/unit.yml b/.github/workflows/unit.yml',
      '--- a/.github/workflows/unit.yml',
      '+++ b/.github/workflows/unit.yml',
      '@@ -1 +1,2 @@',
      '+# why this fork pins the job',
      '+  # and indented too',
      'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx',
      '--- a/src/renderer/App.tsx',
      '+++ b/src/renderer/App.tsx',
      '@@ -1 +1,2 @@',
      '+{/* a rationale only tsx can carry */}',
      '+// and a line comment'
    ].join('\n')
    const counts = collectAddedCommentLines(diff)
    expect(counts.get('.github/workflows/unit.yml')).toBe(2)
    expect(counts.get('src/renderer/App.tsx')).toBe(2)
  })

  it('counts nothing for a file the diff deletes', () => {
    const diff = [
      'diff --git a/src/main/gone.ts b/src/main/gone.ts',
      '--- a/src/main/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-// a removed rationale'
    ].join('\n')
    expect([...collectAddedCommentLines(diff).values()]).toEqual([])
  })
})

describe('evaluate', () => {
  const baseline = { perFileThreshold: 5, total: 10, files: { 'src/a.ts': 6, 'src/gone.ts': 2 } }

  it('passes a diff at or under every frozen maximum', () => {
    const result = evaluate(
      new Map([
        ['src/a.ts', 6],
        ['src/b.ts', 4]
      ]),
      baseline
    )
    expect(result.violations).toEqual([])
    expect(result.total).toBe(10)
    expect(result.stale).toEqual(['src/gone.ts'])
  })

  it('flags a file past its recorded maximum and a new offender at the threshold', () => {
    const result = evaluate(
      new Map([
        ['src/a.ts', 7],
        ['src/b.ts', 6]
      ]),
      baseline
    )
    expect(result.violations).toEqual([
      { file: 'src/a.ts', count: 7, allowed: 6 },
      { file: 'src/b.ts', count: 6, allowed: 0 }
    ])
  })

  it('flags a total above the frozen one even when every file is within its own maximum', () => {
    const result = evaluate(
      new Map([
        ['src/a.ts', 6],
        ['src/b.ts', 4],
        ['src/c.ts', 1]
      ]),
      baseline
    )
    expect(result.violations).toEqual([])
    expect(result.total).toBe(11)
    expect(result.totalAllowed).toBe(10)
  })
})

describe('main', () => {
  it('freezes the current diff, then fails when it grows and passes after --prune', () => {
    const { root, run } = tempRepo()
    const file = join(root, 'upstream.ts')
    mkdirSync(join(root, 'local'), { recursive: true })
    writeFileSync(file, 'export const value = 1\n')
    const base = commit(run, 'base')

    writeFileSync(
      file,
      [
        '// first reason',
        '// second reason',
        '// third reason',
        '// fourth reason',
        '// fifth reason',
        'export const value = 2'
      ].join('\n')
    )
    expect(main(['--init', '--base', base], root)).toBe(0)
    const baseline = JSON.parse(
      readFileSync(join(root, 'local', 'upstream-file-comments-baseline.json'), 'utf8')
    )
    expect(baseline.total).toBe(5)
    expect(baseline.files).toEqual({ 'upstream.ts': 5 })

    expect(main([], root)).toBe(0)

    writeFileSync(
      file,
      [
        '// first reason',
        '// second reason',
        '// third reason',
        '// fourth reason',
        '// fifth reason',
        '// sixth reason',
        'export const value = 2'
      ].join('\n')
    )
    expect(main([], root)).toBe(1)
    // --init may not raise the frozen total against the same base.
    expect(main(['--init'], root)).toBe(1)

    // Re-measuring against a newer base changes what is measured, but growth still needs a reason.
    const newerBase = commit(run, 'six reasons')
    writeFileSync(
      file,
      [
        '// first reason',
        '// second reason',
        '// third reason',
        '// fourth reason',
        '// fifth reason',
        '// sixth reason',
        '// seventh reason',
        'export const value = 2'
      ].join('\n')
    )
    expect(main(['--init'], root)).toBe(1)
    // Re-measuring against a newer base changes what is counted; here it is a shrink.
    expect(main(['--init', '--base', newerBase], root)).toBe(0)
    const rebased = JSON.parse(
      readFileSync(join(root, 'local', 'upstream-file-comments-baseline.json'), 'utf8')
    )
    expect(rebased.base).toBe(newerBase)
    expect(rebased.total).toBe(1)
    expect(main([], root)).toBe(0)

    // Growth the base branch itself caused is accepted explicitly, and the reason is recorded.
    writeFileSync(
      file,
      [
        '// first reason',
        '// second reason',
        '// third reason',
        '// fourth reason',
        '// fifth reason',
        '// sixth reason',
        '// seventh reason',
        '// eighth reason',
        'export const value = 2'
      ].join('\n')
    )
    expect(main(['--init'], root)).toBe(1)
    expect(main(['--init', '--accept', 'nplez1/main grew it'], root)).toBe(0)
    const accepted = JSON.parse(
      readFileSync(join(root, 'local', 'upstream-file-comments-baseline.json'), 'utf8')
    )
    expect(accepted.total).toBe(2)
    expect(accepted.accepted).toBe('nplez1/main grew it')

    // A shrink is a red until it is locked in, so the slack cannot be spent again elsewhere.
    writeFileSync(file, '// one reason\nexport const value = 2\n')
    expect(main([], root)).toBe(1)
    expect(main(['--prune'], root)).toBe(0)
    expect(main([], root)).toBe(0)

    writeFileSync(file, 'export const value = 2\n')
    expect(main(['--prune'], root)).toBe(0)
    expect(
      JSON.parse(readFileSync(join(root, 'local', 'upstream-file-comments-baseline.json'), 'utf8'))
        .files
    ).toEqual({})
  })

  it('rejects a combination that would silently rewrite the baseline twice', () => {
    expect(() => parseArgs(['--init', '--prune'])).toThrow()
    expect(() => parseArgs(['--nope'])).toThrow()
  })
})
