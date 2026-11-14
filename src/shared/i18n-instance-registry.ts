import type { i18n as I18nInstance } from 'i18next'

// Production creates its instances at module load and keeps them, so this holds those and whatever a
// test builds. It lives apart from orca-i18n-instance.ts so a setup file can read it without importing
// i18next: that import leaves a pending timer, and the shared worker's file reset answers a pending
// timer by re-evaluating every module.
// fork-comment-ok: vitest-shared-worker-locale-reset.mjs is the reader, and it carries the why.
// Why weak: a file that makes the i18n module evaluate again (a mock, or a leaked global) registers
// another instance, and this module was loaded by the setup file, so nothing resets it.
const instances: WeakRef<I18nInstance>[] = []

export function registerOrcaI18nInstance(instance: I18nInstance): void {
  instances.push(new WeakRef(instance))
}

export function __orcaI18nInstancesForTests(): readonly I18nInstance[] {
  const live: I18nInstance[] = []
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    const instance = instances[index].deref()
    if (instance) {
      live.push(instance)
    } else {
      instances.splice(index, 1)
    }
  }
  return live
}
