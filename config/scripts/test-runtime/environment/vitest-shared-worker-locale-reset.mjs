// Fork-owned (issue #421). A shared worker's files share one module cache, and the upstream file
// reset can only undo mocks, timers, globals, process state and the modules a file *newly* evaluated.
// A value a module already held survives it, so a file that detects a locale hands it to the next one.
//
// The i18next singleton is the one such value this does not restore: importing src/renderer/src/i18n/i18n.ts
// here would inline every locale catalog (about 15 MB of base64) into every shared worker. The three
// node-env tests that switch it already restore 'en' in their own hooks.
import { afterAll, afterEach } from 'vitest'
import { __resetRendererLanguageDetectionForTests } from '../../../../src/shared/ui-locale'
import { __resetLanguageReadinessForTests } from '../../../../src/renderer/src/i18n/language-readiness'

/** Puts the language detection back on the state a fresh worker holds. */
export function restoreSharedWorkerLocale() {
  __resetRendererLanguageDetectionForTests()
  __resetLanguageReadinessForTests()
}

// Per test, so a file's own tests cannot inherit each other's detection either, and again after it, for
// anything its hooks left behind.
afterEach(() => restoreSharedWorkerLocale())
afterAll(() => restoreSharedWorkerLocale())
