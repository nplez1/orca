import { describe, expect, it } from 'vitest'
import { mergeCatalogs } from '../../config/scripts/fork-english-catalog.mjs'
import {
  mergeLocaleOverlay,
  FORK_OVERLAY_LANGUAGES
} from '../../src/renderer/src/i18n/fork-catalog-overlay'

// Every `i18n/fork/<locale>.json` must be listed by the runtime map: an overlay nobody loads is a
// translation the app never serves, and `de` sat in that state until it was found by hand.
const OVERLAY_FILES = Object.keys(import.meta.glob('../../src/renderer/src/i18n/fork/*.json')).map(
  (path) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
)
const ENGLISH_OVERLAYS = new Set(['en', 'en-runtime-required'])

// Two files implement the overlay rule: the verifiers read through the Node one, the app through the
// renderer one, and they cannot share a module across the TS/mjs boundary. Parity is asserted rather
// than assumed, so a change to one is either mirrored or caught here.
const CASES = [
  [{ menu: { file: 'File', edit: 'Edit' } }, { menu: { file: 'Archivo' } }],
  [{ tray: { activityWaiting: 'Waiting' } }, { tray: { activityWaiting: null } }],
  [{ menu: { gone: 'x' } }, { menu: { gone: null, added: 'y' } }],
  [{ menu: {} }, { menu: { absent: null } }],
  [{ a: 'flat' }, { a: { b: 'nested' } }],
  [{ a: { b: 'nested' } }, { a: 'flat' }],
  [{}, { only: { tombstone: null } }],
  [{}, { mixed: { keep: 'value', drop: null } }],
  [{ keep: 'base' }, { mixed: { drop: null } }],
  [{ deep: { one: { two: 'x', three: 'y' } } }, { deep: { one: { two: null } } }]
]

describe('overlay merge parity', () => {
  it('wires every locale overlay file into the runtime map', () => {
    const onDisk = OVERLAY_FILES.filter((locale) => !ENGLISH_OVERLAYS.has(locale)).sort()
    expect([...FORK_OVERLAY_LANGUAGES].sort()).toEqual(onDisk)
  })

  it.each(CASES.map(([base, overlay], index) => ({ index, base, overlay })))(
    'case $index merges the same way in both implementations',
    ({ base, overlay }) => {
      expect(mergeLocaleOverlay(base, overlay)).toEqual(mergeCatalogs(base, overlay))
    }
  )
})
