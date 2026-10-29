import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeLocaleOverlay } from './fork-catalog-overlay'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from './i18n'
import { UI_LANGUAGE_CHINESE, UI_LANGUAGE_SPANISH } from '../../../shared/ui-language'

describe('mergeLocaleOverlay', () => {
  it('overlays values and drops tombstoned keys', () => {
    expect(
      mergeLocaleOverlay(
        { menu: { file: 'File', edit: 'Edit' }, tray: { activityWaiting: 'Waiting' } },
        { menu: { file: 'Archivo' }, tray: { activityWaiting: null } }
      )
    ).toEqual({ menu: { file: 'Archivo', edit: 'Edit' } })
  })

  it('does not mutate the base catalog', () => {
    const base = { menu: { file: 'File' } }
    mergeLocaleOverlay(base, { menu: { file: null } })
    expect(base).toEqual({ menu: { file: 'File' } })
  })

  it('never leaves a tombstone, or a subtree of nothing but tombstones, in the merged catalog', () => {
    expect(mergeLocaleOverlay({}, { gone: { leaf: null } })).toEqual({})
    expect(mergeLocaleOverlay({ gone: 'flat' }, { gone: { leaf: null } })).toEqual({
      gone: 'flat'
    })
    expect(mergeLocaleOverlay({}, { kept: { leaf: 'value', dropped: null } })).toEqual({
      kept: { leaf: 'value' }
    })
  })
})

// The overlay is a real asset under i18n/fork/, so this exercises the read path i18n.ts uses:
// upstream's catalog fetched, the fork's merged over it, tombstones dropped.
describe('lazy locale catalog with the fork overlay', () => {
  beforeEach(async () => {
    setRendererPluginLanguagePacks([])
    await i18n.changeLanguage('en')
  })

  it('serves a fork-added Spanish string', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(
      i18n.t('auto.components.JiraIssueWorkspace.showWorkspace', {
        defaultValue: 'Show workspace'
      })
    ).toBe('Mostrar espacio de trabajo')
  })

  it('drops an upstream key the fork tombstoned instead of translating it', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(
      i18n.t('auto.components.PullRequestPage.18f2af42ac', { defaultValue: 'Retired copy' })
    ).toBe('Retired copy')
  })

  it('still loads upstream strings for a locale with no fork additions', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_CHINESE)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).not.toBe('File')
  })

  it('gives up on a hung overlay and still loads the language', async () => {
    i18n.removeResourceBundle('es', 'translation')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalFetch = globalThis.fetch
    const request = vi.spyOn(globalThis, 'fetch')
    // Upstream's catalog resolves; the overlay never does.
    request.mockImplementationOnce(originalFetch).mockReturnValueOnce(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const loading = setRendererUiLanguage(UI_LANGUAGE_SPANISH)
      await vi.advanceTimersByTimeAsync(2100)
      await loading
      expect(i18n.language).toBe('es')
      expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      request.mockRestore()
      warn.mockRestore()
    }
  })

  it('keeps the language when the fork overlay cannot be fetched', async () => {
    i18n.removeResourceBundle('es', 'translation')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalFetch = globalThis.fetch
    const request = vi.spyOn(globalThis, 'fetch')
    // Upstream's catalog request goes out first, then the overlay.
    request
      .mockImplementationOnce(originalFetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    try {
      await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
      expect(i18n.language).toBe('es')
      // Upstream's Spanish survives; only the fork's own strings are missing.
      expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')
      expect(
        i18n.t('auto.components.JiraIssueWorkspace.showWorkspace', { defaultValue: 'x' })
      ).toBe('x')
      expect(warn).toHaveBeenCalled()
    } finally {
      request.mockRestore()
      warn.mockRestore()
    }
  })
})
