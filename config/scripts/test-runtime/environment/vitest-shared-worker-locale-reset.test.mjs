import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import {
  getRendererLanguageDetection,
  setRendererLanguageDetection
} from '../../../../src/shared/ui-locale'
import { restoreSharedWorkerLocale } from './vitest-shared-worker-locale-reset.mjs'
import { resolvePinnedBunExecutable } from '../../tool-invocation/pinned-bun-executable.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const SPANISH = { detectedTag: 'es-ES', status: 'supported', locale: 'es', source: 'browser' }

it('puts the detection back on what a fresh worker starts with', () => {
  setRendererLanguageDetection(SPANISH)
  expect(getRendererLanguageDetection().locale).toBe('es')

  restoreSharedWorkerLocale()

  expect(getRendererLanguageDetection().locale).toBe('en')
})

it('drops the cached detection, so the next file detects for itself', async () => {
  const { initializeLanguageDetection, useLanguageReadiness } =
    await import('../../../../src/renderer/src/i18n/language-readiness')
  vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] })
  expect((await initializeLanguageDetection()).locale).toBe('fr')

  // A second file on a Spanish host must not reuse the first file's answer, or its language.
  vi.stubGlobal('navigator', { language: 'ja-JP', languages: ['ja-JP'] })
  restoreSharedWorkerLocale()
  restoreSharedWorkerLocale()

  expect(useLanguageReadiness.getState().detection).toBeNull()
  expect((await initializeLanguageDetection()).locale).toBe('ja')
  restoreSharedWorkerLocale()
  vi.unstubAllGlobals()
})

it('restores the locale a previous shared file left behind', async () => {
  // Not node_modules: vite loads a spec there as a dependency, in its own module instance, so the
  // setup file's reset would be a no-op and the assertion would pass without proving anything.
  const scratch = join(root, '.tmp')
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, 'shared-worker-locale-'))
  // Vite resolves these against the fixture, which lives inside the repo's node_modules.
  const specifier = (file) => {
    const path = relative(directory, resolve(root, file))
    return path.startsWith('.') ? path : `./${path}`
  }
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
       import { useLanguageReadiness } from '${specifier('src/renderer/src/i18n/language-readiness')}'
       import { getRendererLanguageDetection, setRendererLanguageDetection } from '${specifier('src/shared/ui-locale')}'

       const SPANISH = { detectedTag: 'es-ES', status: 'supported', locale: 'es', source: 'browser' }

       it('leaves a Spanish detection for the files after it', () => {
         setRendererLanguageDetection(SPANISH)
         useLanguageReadiness.setState({ detection: SPANISH })
         expect(getRendererLanguageDetection().locale).toBe('es')
         expect(useLanguageReadiness.getState().detection.locale).toBe('es')
         useLanguageReadiness.sharedWorkerFixtureMark = 'planted'
         writeFileSync(new URL('./planted.json', import.meta.url), JSON.stringify({ pid: process.pid }))
       })`
    )
    writeFileSync(
      join(directory, '02-assert.spec.mjs'),
      `import { existsSync, readFileSync } from 'node:fs'
       import { fileURLToPath } from 'node:url'
       import { expect, it } from 'vitest'
       import { useLanguageReadiness } from '${specifier('src/renderer/src/i18n/language-readiness')}'
       import { getRendererLanguageDetection } from '${specifier('src/shared/ui-locale')}'

       it('starts with no detection planted by a file before it', () => {
         const marker = fileURLToPath(new URL('./planted.json', import.meta.url))
         expect(existsSync(marker), 'the sorted fixture ran the planting file after this one').toBe(true)
         expect(JSON.parse(readFileSync(marker, 'utf8')).pid, 'the two files ran in different workers')
           .toBe(process.pid)
         expect(useLanguageReadiness.sharedWorkerFixtureMark, 'the module was re-evaluated, so this proves nothing')
           .toBe('planted')
         expect(useLanguageReadiness.getState().detection).toBeNull()
         expect(getRendererLanguageDetection().locale).toBe('en')
       })`
    )
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
})
