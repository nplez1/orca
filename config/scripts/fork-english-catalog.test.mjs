import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectCatalogTombstones,
  forkLocaleCatalogRelativePath,
  mergeCatalogs,
  readForkLocaleCatalog,
  readMergedLocaleCatalog,
  readEnglishCatalog
} from './fork-english-catalog.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

describe('mergeCatalogs', () => {
  it('merges nested objects over the base', () => {
    expect(
      mergeCatalogs({ menu: { file: 'File', edit: 'Edit' } }, { menu: { file: 'Bestand' } })
    ).toEqual({ menu: { file: 'Bestand', edit: 'Edit' } })
  })

  it('treats a null leaf as a tombstone rather than a value', () => {
    expect(
      mergeCatalogs(
        { menu: { file: 'File', edit: 'Edit' }, tray: { activityWaiting: 'Waiting' } },
        { menu: { file: null }, tray: { activityWaiting: null } }
      )
    ).toEqual({ menu: { edit: 'Edit' } })
  })

  it('ignores a tombstone for a key upstream no longer ships', () => {
    expect(mergeCatalogs({ menu: {} }, { menu: { gone: null } })).toEqual({})
  })

  it('replaces a base leaf with an overlay subtree and vice versa', () => {
    expect(mergeCatalogs({ a: 'flat' }, { a: { b: 'nested' } })).toEqual({ a: { b: 'nested' } })
    expect(mergeCatalogs({ a: { b: 'nested' } }, { a: 'flat' })).toEqual({ a: 'flat' })
  })
})

describe('collectCatalogTombstones', () => {
  it('returns the dot paths of every null leaf and nothing else', () => {
    expect(
      collectCatalogTombstones({
        tray: { activityWaiting: null },
        menu: { file: 'File', nested: { gone: null } }
      })
    ).toEqual(['tray.activityWaiting', 'menu.nested.gone'])
  })
})

describe('fork overlays in this repository', () => {
  it('names one overlay per non-default locale, beside the English one', () => {
    expect(forkLocaleCatalogRelativePath('ja')).toBe(
      path.join('src', 'renderer', 'src', 'i18n', 'fork', 'ja.json')
    )
  })

  it.each(['es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-Hant'])(
    'deletes every %s tombstone from the merged catalog',
    async (locale) => {
      const overlay = await readForkLocaleCatalog(REPO_ROOT, locale)
      const merged = await readMergedLocaleCatalog(REPO_ROOT, locale)
      const tombstones = collectCatalogTombstones(overlay)
      expect(tombstones.length).toBeGreaterThan(0)
      const stillPresent = tombstones.filter((key) => lookup(merged, key) !== undefined)
      expect(stillPresent).toEqual([])
    }
  )

  it.each(['es', 'fr', 'ja', 'ko', 'zh'])(
    'carries the fork strings %s added back into the merged catalog',
    async (locale) => {
      const overlay = await readForkLocaleCatalog(REPO_ROOT, locale)
      const merged = await readMergedLocaleCatalog(REPO_ROOT, locale)
      const strings = entries(overlay).filter(([, value]) => typeof value === 'string')
      expect(strings.length).toBeGreaterThan(0)
      for (const [key, value] of strings) {
        expect(lookup(merged, key)).toBe(value)
      }
    }
  )

  it('keeps the English overlay tombstones out of the merged English catalog', async () => {
    const merged = await readEnglishCatalog(REPO_ROOT)
    expect(lookup(merged, 'tray.activityWaiting')).toBeUndefined()
    expect(lookup(merged, 'jira.transitions.unsupported')).toBeUndefined()
  })
})

function lookup(catalog, dottedKey) {
  return dottedKey.split('.').reduce((cursor, part) => cursor?.[part], catalog)
}

function entries(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [[prefix, value]]
  }
  return Object.entries(value).flatMap(([key, child]) =>
    entries(child, prefix ? `${prefix}.${key}` : key)
  )
}
