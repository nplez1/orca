// Fork-owned (issue #421). A shared worker's files share one module cache, and the upstream file
// reset can only undo mocks, timers, globals, process state and the modules a file *newly* evaluated.
// A value a module already held survives it, so a file that switched locale hands it to the next one.
// This is preventive: no shared file does that today, and #430 already fixed the two that did.
import { afterAll, vi } from 'vitest'
import {
  DEFAULT_UI_LOCALE,
  __resetRendererLanguageDetectionForTests
} from '../../../../src/shared/ui-locale'
import { __resetLanguageReadinessForTests } from '../../../../src/renderer/src/i18n/language-readiness'
import { __orcaI18nInstancesForTests } from '../../../../src/shared/i18n-instance-registry'

/**
 * Puts the locale state a shared file can leave behind back on what a fresh worker holds. The i18n
 * instances come from their creator's registry: importing src/renderer/src/i18n/i18n.ts here would
 * inline every locale catalog into every shared worker, and importing i18next itself would leave a
 * pending timer, which the file reset answers by re-evaluating every module.
 */
export async function restoreSharedWorkerLocale() {
  // Earlier than the file reset's own: a catalog this file loaded in the background may still be
  // arriving, and it would land on the language restored below. Fetched catalogs cannot be waited for.
  await vi.dynamicImportSettled()
  __resetRendererLanguageDetectionForTests()
  __resetLanguageReadinessForTests()
  const switched = __orcaI18nInstancesForTests()
    .filter((i18n) => i18n.language !== DEFAULT_UI_LOCALE)
    .map((i18n) => i18n.changeLanguage(DEFAULT_UI_LOCALE))
  await Promise.all(switched)
}

afterAll(() => restoreSharedWorkerLocale())
