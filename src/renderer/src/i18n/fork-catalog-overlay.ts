import { withTimeout } from '../../../shared/promise-timeout-fallback'
import forkDeCatalogUrl from './fork/de.json?url'
import forkEsCatalogUrl from './fork/es.json?url'
import forkFrCatalogUrl from './fork/fr.json?url'
import forkJaCatalogUrl from './fork/ja.json?url'
import forkKoCatalogUrl from './fork/ko.json?url'
import forkPtCatalogUrl from './fork/pt.json?url'
import forkRuCatalogUrl from './fork/ru.json?url'
import forkTrCatalogUrl from './fork/tr.json?url'
import forkZhCatalogUrl from './fork/zh.json?url'
import forkZhHantCatalogUrl from './fork/zh-Hant.json?url'

/**
 * The fork's per-locale catalogs, merged over upstream's at read time.
 *
 * Upstream owns every file under `i18n/locales/` byte-for-byte, so the fork's added and overridden
 * strings live in `i18n/fork/<locale>.json` and a `null` leaf is a tombstone: a feature the fork
 * dropped, whose upstream key must disappear without editing upstream's file. Mirrors
 * `config/scripts/fork-english-catalog.mjs` `mergeCatalogs`, which every verifier reads through;
 * `tests/tools/i18n-catalog-overlay-parity.test.mjs` keeps the two in step.
 */
const FORK_LOCALE_URLS: Record<string, string> = {
  de: forkDeCatalogUrl,
  es: forkEsCatalogUrl,
  fr: forkFrCatalogUrl,
  ja: forkJaCatalogUrl,
  ko: forkKoCatalogUrl,
  pt: forkPtCatalogUrl,
  ru: forkRuCatalogUrl,
  tr: forkTrCatalogUrl,
  zh: forkZhCatalogUrl,
  'zh-Hant': forkZhHantCatalogUrl
}

/** Wired by `FORK_LOCALE_URLS`; a fork overlay file no language lists is a catalog the app never reads. */
export const FORK_OVERLAY_LANGUAGES: readonly string[] = Object.keys(FORK_LOCALE_URLS)

const FORK_OVERLAY_TIMEOUT_MS = 2000

export function mergeLocaleOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete merged[key]
      continue
    }
    const existing = merged[key]
    const existingIsObject = isPlainObject(existing)
    if (!isPlainObject(value)) {
      merged[key] = value
      continue
    }
    const combined = mergeLocaleOverlay(existingIsObject ? existing : {}, value)
    if (Object.keys(combined).length > 0) {
      merged[key] = combined
    } else if (existingIsObject) {
      delete merged[key]
    }
  }
  return merged
}

async function fetchOverlay(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Overlay catalog request failed: ${response.status}`)
  }
  return response.json()
}

/**
 * The fork's overlay for one language, or `{}`. Its own fetch is bounded and never gates the language:
 * a missing or slow overlay costs the fork's strings, not the whole catalog, and says so once.
 */
export async function loadForkLocaleOverlay(language: string): Promise<Record<string, unknown>> {
  const url = FORK_LOCALE_URLS[language]
  if (!url) {
    return {}
  }
  const outcome = await withTimeout(
    fetchOverlay(url).then(
      (catalog) => ({ ok: true as const, catalog }),
      (error: unknown) => ({ ok: false as const, reason: String(error) })
    ),
    FORK_OVERLAY_TIMEOUT_MS,
    { ok: false as const, reason: `no response in ${FORK_OVERLAY_TIMEOUT_MS}ms` }
  )
  if (!outcome.ok) {
    console.warn(
      `[i18n] fork ${language} overlay unavailable (${outcome.reason}); using upstream's catalog`
    )
    return {}
  }
  return outcome.catalog
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
