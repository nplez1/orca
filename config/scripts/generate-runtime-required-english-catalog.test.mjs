import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  FORK_EN_CATALOG_RELATIVE_PATH,
  FORK_RUNTIME_REQUIRED_RELATIVE_PATH,
  UPSTREAM_EN_CATALOG_RELATIVE_PATH,
  UPSTREAM_RUNTIME_REQUIRED_RELATIVE_PATH
} from './fork-english-catalog.mjs'
import {
  buildRuntimeRequiredCatalog,
  collectRuntimeRequiredCatalogProblems,
  collectRuntimeRequiredKeys,
  main
} from './generate-runtime-required-english-catalog.mjs'

const entries = new Map([
  ['plain.match', 'Save'],
  ['plain.drift', 'Server name'],
  ['plain.conflicting', 'Retry'],
  ['plain.dynamicDefault', 'Connected'],
  ['plain.unreferenced', 'Legacy copy'],
  ['count.thing_one', '{{count}} thing'],
  ['count.thing_other', '{{count}} things']
])

const references = [
  { key: 'plain.match', fallback: 'Save' },
  { key: 'plain.drift', fallback: 'Name in Orca' },
  { key: 'plain.conflicting', fallback: 'Retry' },
  { key: 'plain.conflicting', fallback: 'Try again' },
  { key: 'plain.dynamicDefault', fallback: undefined },
  { key: 'count.thing_one', fallback: '{{count}} thing' }
]

describe('runtime-required English catalog rule', () => {
  it('drops only entries every call site already spells identically', () => {
    expect([...collectRuntimeRequiredKeys(entries, references)].sort()).toEqual([
      'count.thing_one',
      'count.thing_other',
      'plain.conflicting',
      'plain.drift',
      'plain.dynamicDefault',
      'plain.unreferenced'
    ])
  })

  // Committed output must not vary with filesystem walk order or CI drift checks flap.
  it('produces byte-identical output whatever order the call sites are visited in', () => {
    const shuffled = references.toReversed()
    const forward = JSON.stringify(
      buildRuntimeRequiredCatalog(entries, collectRuntimeRequiredKeys(entries, references)),
      null,
      2
    )
    const reversed = JSON.stringify(
      buildRuntimeRequiredCatalog(entries, collectRuntimeRequiredKeys(entries, shuffled)),
      null,
      2
    )

    expect(reversed).toBe(forward)
    // Code-unit order, not locale collation: `sort()` must stay locale-free.
    expect(Object.keys(JSON.parse(forward))).toEqual(['count', 'plain'])
  })

  it('accepts a subset carrying entries that are no longer required', () => {
    const required = collectRuntimeRequiredKeys(entries, references)
    const shipped = new Map([...required].map((key) => [key, entries.get(key)]))
    shipped.set('plain.match', 'Save')

    const problems = collectRuntimeRequiredCatalogProblems(entries, required, shipped)

    expect(problems.missing).toEqual([])
    expect(problems.contradicting).toEqual([])
    expect(problems.superfluous).toEqual(['plain.match'])
  })

  it('rejects a subset that is missing a required entry or contradicts en.json', () => {
    const required = collectRuntimeRequiredKeys(entries, references)
    const shipped = new Map([...required].map((key) => [key, entries.get(key)]))
    shipped.delete('plain.drift')
    shipped.set('plain.conflicting', 'Stale text')

    const problems = collectRuntimeRequiredCatalogProblems(entries, required, shipped)

    expect(problems.missing).toEqual(['plain.drift'])
    expect(problems.contradicting).toEqual(['plain.conflicting'])
  })

  it('rebuilds the nested catalog shape with the English values', () => {
    const required = collectRuntimeRequiredKeys(entries, references)

    expect(buildRuntimeRequiredCatalog(entries, required)).toEqual({
      count: { thing_one: '{{count}} thing', thing_other: '{{count}} things' },
      plain: {
        conflicting: 'Retry',
        drift: 'Server name',
        dynamicDefault: 'Connected',
        unreferenced: 'Legacy copy'
      }
    })
  })

  it('writes only what upstream omits or contradicts to the fork subset', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-runtime-required-fork-'))
    try {
      const write = (relative, value) => {
        mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
        writeFileSync(path.join(root, relative), JSON.stringify(value))
      }
      write('src/main/ready.ts', '')
      write(UPSTREAM_EN_CATALOG_RELATIVE_PATH, {
        upstream: { plural_one: 'Old', same_one: 'Same' }
      })
      write(UPSTREAM_RUNTIME_REQUIRED_RELATIVE_PATH, {
        upstream: { plural_one: 'Old', same_one: 'Same' }
      })
      write(FORK_EN_CATALOG_RELATIVE_PATH, {
        upstream: { plural_one: 'New' },
        fork: { plural_one: 'Fork' }
      })

      expect(await main(root, [])).toBe(1)
      expect(await main(root, ['--fix'])).toBe(0)
      expect(await main(root, [])).toBe(0)

      const read = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
      expect(read(FORK_RUNTIME_REQUIRED_RELATIVE_PATH)).toEqual({
        fork: { plural_one: 'Fork' },
        upstream: { plural_one: 'New' }
      })
      expect(read(UPSTREAM_RUNTIME_REQUIRED_RELATIVE_PATH)).toEqual({
        upstream: { plural_one: 'Old', same_one: 'Same' }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
