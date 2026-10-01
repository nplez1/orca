import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

// Why mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'
const GRAB_HANDLE_SELECTOR = '[data-floating-terminal-drag-handle]'
const TAB_STRIP_SELECTOR = '.terminal-tab-strip'

async function openFloatingPanelWithTabs(page: Page, tabCount: number): Promise<void> {
  await page.evaluate(
    async ({ worktreeId, count }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      await store.getState().updateSettings({ floatingTerminalEnabled: true })
      const directory = await window.api.app.getFloatingMarkdownDirectory()
      const suffix = Date.now().toString(36)
      for (let index = 0; index < count; index += 1) {
        const relativePath = `grab-handle-${suffix}-${index}.md`
        const filePath = `${directory}/${relativePath}`
        await window.api.fs.createFile({ filePath })
        await window.api.fs.writeFile({ filePath, content: `# Grab handle ${index}\n` })
        await store.getState().openFile(
          {
            filePath,
            relativePath,
            worktreeId,
            language: 'markdown',
            mode: 'edit',
            runtimeEnvironmentId: null
          },
          { preview: false, suppressActiveRuntimeFallback: true }
        )
      }
    },
    { worktreeId: FLOATING_WORKTREE_ID, count: tabCount }
  )

  await page.waitForFunction(
    (selector) => Boolean(document.querySelector(selector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  // Why: the open flag is persisted, so after a restart the panel is already open and a blind toggle would close it.
  const alreadyOpen = await page.evaluate(
    (selector) => Boolean(document.querySelector(selector)),
    OPEN_PANEL_SELECTOR
  )
  if (!alreadyOpen) {
    await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  }
  await expect(page.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
}

test('the floating titlebar grab handle stays reachable above a full tab strip', async ({
  orcaPage
}) => {
  await openFloatingPanelWithTabs(orcaPage, 14)

  const panel = orcaPage.locator(OPEN_PANEL_SELECTOR)
  const handle = panel.locator(GRAB_HANDLE_SELECTOR)
  await expect(handle).toBeVisible()
  // Why: more tabs than fit is the case the handle exists for; without overflow this proves nothing.
  expect(await panel.locator(`${TAB_STRIP_SELECTOR} [data-tab-id]`).count()).toBeGreaterThan(5)

  const handleBox = await handle.boundingBox()
  const stripBox = await panel.locator(TAB_STRIP_SELECTOR).first().boundingBox()
  const before = await panel.boundingBox()
  if (!handleBox || !stripBox || !before) {
    throw new Error('floating titlebar geometry unavailable')
  }
  // The handle owns the far-left edge, so the overflowing strip can never cover it.
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(stripBox.x + 1)

  // Why per-axis direction: the panel is anchored bottom-right by default, so always
  // dragging up-left would clamp and pass vacuously on a small window.
  const dx = before.x > 140 ? -70 : 70
  const dy = before.y > 140 ? -40 : 40
  const startX = handleBox.x + handleBox.width / 2
  const startY = handleBox.y + handleBox.height / 2
  await orcaPage.mouse.move(startX, startY)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(startX + dx, startY + dy, { steps: 10 })
  await orcaPage.mouse.up()

  await expect
    .poll(async () => Math.abs(((await panel.boundingBox())?.x ?? before.x) - before.x))
    .toBeGreaterThan(30)
})
