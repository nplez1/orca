// Visual + DOM proof for Settings → Advanced → Debug Options → "Log UI hangs".
// Run: ORCA_BACKGROUND_LAUNCH=1 node tests/tools/ui-hang-logging-ui/run.mjs
// Builds the production AdvancedPane with real styles, renders it in a hidden Electron window,
// and records screenshots under .bench-fixtures/ui-hang-logging-*/.
import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'ui-hang-logging-'))
const home = path.join(output, 'home')
mkdirSync(home)

const main = path.join(output, 'main.cjs')
await buildMain({
  entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron']
})
await buildRenderer({
  configFile: false,
  root: import.meta.dirname,
  base: './',
  logLevel: 'silent',
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
  build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
})

const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
const app = await electron.launch({
  args: [main],
  env: { ...env, HOME: home, ZDOTDIR: home, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = {
  scope:
    'Production AdvancedPane in hidden Electron; stubbed uiHangDiagnostics status; no logging run',
  errors: []
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => report.errors.push(error.message))
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)

  const toggle = page.getByRole('switch', { name: 'Log UI hangs' })
  await expect(toggle).toBeVisible()
  await expect(page.getByText('Debug Options', { exact: true })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.screenshot({ path: path.join(output, 'debug-options-off.png'), fullPage: true })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('ui-hangs.ndjson')).toBeVisible()
  await page.screenshot({ path: path.join(output, 'debug-options-on.png'), fullPage: true })

  report.hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(report.hidden).toBe(true)
  expect(report.errors).toEqual([])
  report.passed = true
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(output)
  await app.close()
}
