import { describe, expect, it } from 'vitest'
import { mergeCatalogs } from '../../config/scripts/fork-english-catalog.mjs'
import { mergeLocaleOverlay } from '../../src/renderer/src/i18n/fork-catalog-overlay'

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
  it.each(CASES.map(([base, overlay], index) => ({ index, base, overlay })))(
    'case $index merges the same way in both implementations',
    ({ base, overlay }) => {
      expect(mergeLocaleOverlay(base, overlay)).toEqual(mergeCatalogs(base, overlay))
    }
  )
})
