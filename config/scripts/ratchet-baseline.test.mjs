import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  diffCounts,
  diffEntries,
  formatCountBaseline,
  parseCountBaseline,
  parseCountNotes,
  parseEntryBaseline,
  readCountBaseline,
  runCountRatchet,
  runEntryRatchet
} from './ratchet-baseline.mjs'

describe('entry baseline', () => {
  it('drops comments and blank lines and trims, so formatting cannot invent entries', () => {
    expect(parseEntryBaseline('# header\n\n inline a.ts \nmobile-config x/*.tsx\n')).toEqual([
      'inline a.ts',
      'mobile-config x/*.tsx'
    ])
  })

  it('reports added and stale entries', () => {
    expect(diffEntries(['b.ts', 'c.ts'], ['a.ts', 'b.ts'])).toEqual({
      added: ['c.ts'],
      stale: ['a.ts']
    })
    expect(diffEntries(['a.ts'], ['a.ts'])).toEqual({ added: [], stale: [] })
  })
})

describe('runEntryRatchet', () => {
  let root
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function ratchet(current) {
    root = mkdtempSync(join(tmpdir(), 'orca-ratchet-'))
    writeFileSync(join(root, 'baseline.txt'), '# header\na.ts\nb.ts\n')
    return {
      name: 'demo',
      baselinePath: 'baseline.txt',
      header: ['# header'],
      collect: () => current,
      fix: ['Fix the file.']
    }
  }

  it('fails a new entry and a stale one, and passes the baseline as-is', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runEntryRatchet(ratchet(['a.ts', 'b.ts', 'c.ts']), root)).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('New demo entry not allowed: c.ts')
    expect(runEntryRatchet(ratchet(['a.ts']), root)).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('Stale demo baseline entry (prune it): b.ts')
    expect(runEntryRatchet(ratchet(['b.ts', 'a.ts']), root)).toBe(0)
  })

  it('prunes stale entries only and still fails on a new one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runEntryRatchet(ratchet(['a.ts', 'c.ts']), root, '--prune')).toBe(1)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe('# header\na.ts\n')
  })
})

describe('runCountRatchet', () => {
  let root
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function ratchet(current) {
    root = mkdtempSync(join(tmpdir(), 'orca-count-ratchet-'))
    writeFileSync(join(root, 'baseline.txt'), '# header\n2 a.ts # why\n1 b.ts\n')
    return {
      name: 'demo',
      baselinePath: 'baseline.txt',
      header: ['# header'],
      collect: () => new Map(current),
      unit: 'thing(s)',
      fix: ['Fix the file.']
    }
  }

  it('fails growth and an unpruned shrink, and passes the baseline as-is', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      runCountRatchet(
        ratchet([
          ['a.ts', 3],
          ['b.ts', 1]
        ]),
        root
      )
    ).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('a.ts: 3 thing(s), baseline allows 2.')
    expect(runCountRatchet(ratchet([['a.ts', 2]]), root)).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('b.ts: now 0, baseline 1.')
    expect(
      runCountRatchet(
        ratchet([
          ['b.ts', 1],
          ['a.ts', 2]
        ]),
        root
      )
    ).toBe(0)
  })

  it('prunes rows down only, keeping their notes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      runCountRatchet(
        ratchet([
          ['a.ts', 1],
          ['c.ts', 4]
        ]),
        root,
        '--prune'
      )
    ).toBe(0)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe('# header\n1 a.ts # why\n')
  })
})

describe('count baseline overlay', () => {
  let root
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  const BASE = '# upstream\n2 a.ts\n1 b.ts\n3 c.ts\n2 d.ts\n'

  function ratchet(current, overlay) {
    root = mkdtempSync(join(tmpdir(), 'orca-count-overlay-'))
    writeFileSync(join(root, 'baseline.txt'), BASE)
    if (overlay !== undefined) {
      writeFileSync(join(root, 'baseline.fork.txt'), overlay)
    }
    return {
      name: 'demo',
      baselinePath: 'baseline.txt',
      overlayPath: 'baseline.fork.txt',
      header: ['# upstream'],
      collect: () => new Map(current),
      unit: 'thing(s)',
      fix: ['Fix the file.']
    }
  }

  it('replaces base rows per key, and a 0 row withdraws the allowance', () => {
    ratchet([], '# fork\n4 a.ts # fork-only reads\n0 b.ts # fork fixed it\n1 new.ts\n')
    expect(readCountBaseline(root, 'baseline.txt', 'baseline.fork.txt')).toEqual(
      new Map([
        ['a.ts', 4],
        ['b.ts', 0],
        ['c.ts', 3],
        ['d.ts', 2],
        ['new.ts', 1]
      ])
    )
  })

  it('enforces the merged counts, so a 0 row fails a file upstream still allows', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const overlay = '4 a.ts\n0 b.ts\n'
    const merged = [
      ['a.ts', 4],
      ['c.ts', 3],
      ['d.ts', 2]
    ]
    expect(runCountRatchet(ratchet(merged, overlay), root)).toBe(0)
    expect(runCountRatchet(ratchet([...merged, ['b.ts', 1]], overlay), root)).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('b.ts: 1 thing(s), baseline allows 0.')
  })

  it('reads the base alone when the overlay file is missing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const current = [
      ['a.ts', 2],
      ['b.ts', 1],
      ['c.ts', 3],
      ['d.ts', 2]
    ]
    expect(runCountRatchet(ratchet(current), root)).toBe(0)
    expect(readCountBaseline(root, 'baseline.txt', 'baseline.fork.txt')).toEqual(
      readCountBaseline(root, 'baseline.txt')
    )
  })

  it('prunes into the overlay, keeping notes and dropping rows that match the base', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const overlay =
      '# fork\n\n4 a.ts # fork-only reads\n0 b.ts # fork fixed it\n9 c.ts # stale\n5 gone.ts\n'
    const current = [
      ['a.ts', 3],
      ['c.ts', 3],
      ['d.ts', 1],
      ['new.ts', 2]
    ]
    expect(runCountRatchet(ratchet(current, overlay), root, '--prune')).toBe(0)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe(BASE)
    expect(readFileSync(join(root, 'baseline.fork.txt'), 'utf8')).toBe(
      '# fork\n3 a.ts # fork-only reads\n0 b.ts # fork fixed it\n1 d.ts\n'
    )
  })

  it('prunes the base as before when there is no overlay', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runCountRatchet(ratchet([['a.ts', 1]]), root, '--prune')).toBe(0)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe('# upstream\n1 a.ts\n')
  })
})

describe('count baseline', () => {
  it('round-trips through format and parse, dropping zero rows', () => {
    const counts = new Map([
      ['src/b.ts', 2],
      ['src/a.ts', 1],
      ['src/c.ts', 0]
    ])
    const formatted = formatCountBaseline(counts, ['# header'])
    expect(formatted).toBe('# header\n1 src/a.ts\n2 src/b.ts\n')
    expect(parseCountBaseline(formatted)).toEqual(
      new Map([
        ['src/a.ts', 1],
        ['src/b.ts', 2]
      ])
    )
  })

  it('keeps a row note through a prune', () => {
    const text = formatCountBaseline(
      new Map([['src/a.ts', 1]]),
      ['# header'],
      new Map([['src/a.ts', 'waits for V4b']])
    )
    expect(text).toBe('# header\n1 src/a.ts # waits for V4b\n')
    expect(parseCountBaseline(text)).toEqual(new Map([['src/a.ts', 1]]))
    expect(parseCountNotes(text)).toEqual(new Map([['src/a.ts', 'waits for V4b']]))
  })

  it('fails growth, including a new file, and asks to prune shrinkage', () => {
    const { grown, shrunk } = diffCounts(
      new Map([
        ['src/a.ts', 3],
        ['src/new.ts', 1],
        ['src/b.ts', 1]
      ]),
      new Map([
        ['src/a.ts', 2],
        ['src/b.ts', 2],
        ['src/gone.ts', 1]
      ])
    )
    expect(grown).toEqual([
      { file: 'src/a.ts', now: 3, allowed: 2 },
      { file: 'src/new.ts', now: 1, allowed: 0 }
    ])
    expect(shrunk).toEqual([
      { file: 'src/b.ts', now: 1, allowed: 2 },
      { file: 'src/gone.ts', now: 0, allowed: 1 }
    ])
  })
})
