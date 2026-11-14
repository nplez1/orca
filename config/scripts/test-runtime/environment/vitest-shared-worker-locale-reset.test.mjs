import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import {
  getRendererLanguageDetection,
  setRendererLanguageDetection
} from '../../../../src/shared/ui-locale'
import { restoreSharedWorkerLocale } from './vitest-shared-worker-locale-reset.mjs'
import { resolvePinnedBunExecutable } from '../../tool-invocation/pinned-bun-executable.mjs'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const SPANISH = { detectedTag: 'es-ES', status: 'supported', locale: 'es', source: 'browser' }

afterEach(() => vi.unstubAllGlobals())

it('puts the detection back on what a fresh worker starts with', async () => {
  vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE'] })
  setRendererLanguageDetection(SPANISH)
  expect(getRendererLanguageDetection().locale).toBe('es')

  await restoreSharedWorkerLocale()

  expect(getRendererLanguageDetection().locale).toBe('de')
})

it('drops the cached detection, so the next file detects for itself', async () => {
  const { initializeLanguageDetection, useLanguageReadiness } =
    await import('../../../../src/renderer/src/i18n/language-readiness')
  vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] })
  expect((await initializeLanguageDetection()).locale).toBe('fr')

  // A second file on another host must not reuse the first file's cached answer, or its language.
  vi.stubGlobal('navigator', { language: 'ja-JP', languages: ['ja-JP'] })
  await restoreSharedWorkerLocale()

  expect(useLanguageReadiness.getState().detection).toBeNull()
  expect((await initializeLanguageDetection()).locale).toBe('ja')
  await restoreSharedWorkerLocale()
})

it('puts the i18n instance a file switched back on English', async () => {
  const { i18n, setRendererUiLanguage } = await import('../../../../src/renderer/src/i18n/i18n')
  await setRendererUiLanguage('es')
  expect(i18n.language).toBe('es')

  await restoreSharedWorkerLocale()

  expect(i18n.language).toBe('en')
})

it('restores the locale a previous shared file left behind', async () => {
  // Not node_modules: vite loads a spec there as a dependency, in its own module instance, so the
  // setup file's reset would reach a different copy and the assertions would pass without proving
  // anything. Anything in the repo outside node_modules shares the setup file's modules.
  const scratch = join(root, '.tmp')
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, 'shared-worker-locale-'))
  const specifier = (file) => `./${relative(directory, resolve(root, file))}`
  const setupFiles = [
    resolve(root, 'config/scripts/test-runtime/environment/vitest-shared-worker-file-reset.mjs'),
    resolve(root, 'config/scripts/test-runtime/environment/vitest-shared-worker-locale-reset.mjs')
  ]
  const fixture = relative(root, directory)
  try {
    writeFileSync(
      join(directory, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'
       import { BaseSequencer } from 'vitest/node'
       class Ordered extends BaseSequencer {
         async sort(specs) { return specs.sort((a, b) => a.moduleId.localeCompare(b.moduleId)) }
       }
       export default defineConfig({ test: {
         root: ${JSON.stringify(root)},
         include: ['${fixture}/*.spec.mjs'], isolate: false, maxWorkers: 1,
         setupFiles: [${setupFiles.map((file) => JSON.stringify(file)).join(', ')}],
         sequence: { sequencer: Ordered }
       } })`
    )
    writeFileSync(
      join(directory, '01-plant.spec.mjs'),
      `import { writeFileSync } from 'node:fs'
       import { expect, it } from 'vitest'
       import { registerOrcaI18nInstance } from '${specifier('src/shared/i18n-instance-registry')}'
       import { getRendererLanguageDetection, setRendererLanguageDetection } from '${specifier('src/shared/ui-locale')}'

       const SPANISH = { detectedTag: 'es-ES', status: 'supported', locale: 'es', source: 'browser' }

       it('leaves a Spanish locale for the files after it', () => {
         setRendererLanguageDetection(SPANISH)
         expect(getRendererLanguageDetection().locale).toBe('es')
         // Stands in for the i18next singleton: importing the real one leaves a pending timer, and
         // the file reset answers that by re-evaluating modules, which this witness could not read.
         const i18n = {
           language: 'es',
           sharedWorkerFixtureMark: 'planted',
           changeLanguage: async (next) => {
             i18n.language = next
           }
         }
         registerOrcaI18nInstance(i18n)
         writeFileSync(new URL('./planted.json', import.meta.url), JSON.stringify({ pid: process.pid }))
       })`
    )
    // Two later files, so a hook that attached to only one of them could not carry both.
    for (const name of ['02-assert.spec.mjs', '03-assert.spec.mjs']) {
      writeFileSync(
        join(directory, name),
        `import { existsSync, readFileSync } from 'node:fs'
       import { fileURLToPath } from 'node:url'
       import { expect, it } from 'vitest'
       import { __orcaI18nInstancesForTests } from '${specifier('src/shared/i18n-instance-registry')}'
       import { getBrowserLanguageDetection, getRendererLanguageDetection } from '${specifier('src/shared/ui-locale')}'

       it('starts with no locale planted by a file before it', () => {
         const marker = fileURLToPath(new URL('./planted.json', import.meta.url))
         expect(existsSync(marker), 'the sorted fixture ran the planting file after this one').toBe(true)
         expect(JSON.parse(readFileSync(marker, 'utf8')).pid, 'the two files ran in different workers')
           .toBe(process.pid)
         // Carrying the planting file's mark also proves this is its module instance, so the
         // assertions below cannot pass by the module graph having been re-evaluated instead.
         const planted = __orcaI18nInstancesForTests().find((i18n) => i18n.sharedWorkerFixtureMark === 'planted')
         expect(planted, 'the instance registry was re-evaluated, so this proves nothing').toBeDefined()
         expect(planted.language).toBe('en')
         expect(getRendererLanguageDetection()).toEqual(getBrowserLanguageDetection())
       })`
      )
    }
    const result = await runProcess({
      program: resolvePinnedBunExecutable(root, runProcessSync) ?? 'bun',
      args: [
        '--bun',
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(directory, 'vitest.config.mjs')
      ],
      cwd: root,
      // This shell exports a worker cap that Vitest applies after the config's maxWorkers, and one
      // worker is the whole point of the fixture: two would give each file its own module cache.
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', VITEST_MAX_WORKERS: '1' },
      timeoutMs: 60_000
    })
    expect(result.code, result.stdout + result.stderr).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
