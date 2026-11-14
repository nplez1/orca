import type { i18n as I18nInstance } from 'i18next'

// Production creates its instances at module load and keeps them, so this holds those and whatever a
// test builds. It lives apart from orca-i18n-instance.ts so a setup file can read it without importing
// i18next: that import leaves a pending timer, and the shared worker's file reset answers a pending
// timer by re-evaluating every module.
// fork-comment-ok: vitest-shared-worker-locale-reset.mjs is the reader, and it carries the why.
const instances: I18nInstance[] = []

export function registerOrcaI18nInstance(instance: I18nInstance): void {
  instances.push(instance)
}

export function __orcaI18nInstancesForTests(): readonly I18nInstance[] {
  return instances
}
