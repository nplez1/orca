import type { Page } from '@playwright/test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

/**
 * Keyboard focus is the shortcut context (`getKeybindingContext` reports
 * 'terminal' only while the xterm helper owns focus), so a click on chrome that
 * has no use for typed input must hand focus back to the displayed agent tab.
 */

async function prepareTerminal(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await clickIntoTerminal(page)
}

/** A real pointer click, so focus comes from a gesture rather than from the test. */
async function clickIntoTerminal(page: Page): Promise<void> {
  await page.locator('[data-terminal-tab-id]:visible .xterm-screen').first().click()
  await expect
    .poll(() => activeElementInfo(page).then((info) => info?.isTerminalHelper ?? false))
    .toBe(true)
}

type ActiveElementInfo = { isTerminalHelper: boolean; tabId: string | null; inSidebar: boolean }

async function activeElementInfo(page: Page): Promise<ActiveElementInfo | null> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      return null
    }
    return {
      isTerminalHelper: active.classList.contains('xterm-helper-textarea'),
      tabId: active.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ?? null,
      inSidebar: active.closest('[data-worktree-sidebar]') !== null
    }
  })
}

/** True once the active worktree's displayed agent tab owns keyboard focus. */
async function activeAgentTabHasFocus(page: Page): Promise<boolean> {
  const info = await activeElementInfo(page)
  if (!info?.isTerminalHelper || info.inSidebar) {
    return false
  }
  const expectedTabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    return state?.activeTabType === 'terminal' ? (state.activeTabId ?? null) : null
  })
  return expectedTabId !== null && info.tabId === expectedTabId
}

test('clicking a sidebar workspace card keeps keyboard focus in the agent tab', async ({
  orcaPage
}) => {
  await prepareTerminal(orcaPage)
  const source = await waitForActiveWorktree(orcaPage)
  const target = (await getAllWorktreeIds(orcaPage)).find((id) => id !== source)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  // Why: visit the target first so its terminal is already mounted — otherwise the
  // mount focuses itself and this cannot tell a stranding click from a mount handoff.
  // The sleeping-workspace case is worktree-jump-sleep-focus.spec.ts.
  await switchToWorktree(orcaPage, target)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await switchToWorktree(orcaPage, source)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await clickIntoTerminal(orcaPage)

  const card = orcaPage.locator(`[role="option"][data-worktree-id="${target}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.click()
  await expect(card).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
  await expect.poll(() => activeAgentTabHasFocus(orcaPage), { timeout: 20_000 }).toBe(true)
  const info = await activeElementInfo(orcaPage)
  expect(info?.inSidebar).toBe(false)
})

test('switching right-sidebar panels keeps keyboard focus in the agent tab', async ({
  orcaPage
}) => {
  await prepareTerminal(orcaPage)
  await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarOpen(true))
  await clickIntoTerminal(orcaPage)

  for (const name of ['Checks', 'Source Control', 'Explorer']) {
    const activityButton = orcaPage.locator(`button[aria-label^="${name}"]`).first()
    await expect(activityButton).toBeVisible({ timeout: 15_000 })
    await activityButton.click()
    await expect.poll(() => activeAgentTabHasFocus(orcaPage), { timeout: 5_000 }).toBe(true)
  }
})

test('a keyboard-activated panel tab keeps its own focus', async ({ orcaPage }) => {
  await prepareTerminal(orcaPage)
  await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarOpen(true))

  const activityButton = orcaPage.locator('button[aria-label^="Source Control"]').first()
  await expect(activityButton).toBeVisible({ timeout: 15_000 })
  // Enter on a focused button synthesises a detail-0 click, which is not a gesture
  // that should hand the caret to the agent.
  await activityButton.focus()
  await orcaPage.keyboard.press('Enter')
  await orcaPage.waitForTimeout(300)

  await expect(activityButton).toBeFocused()
  expect((await activeElementInfo(orcaPage))?.isTerminalHelper).toBe(false)
})

test('an explicit search request still takes focus from the agent tab', async ({ orcaPage }) => {
  await prepareTerminal(orcaPage)

  await orcaPage.evaluate(() => window.__store?.getState().showAiVaultSearch())

  const input = orcaPage.getByRole('textbox', { name: 'Search sessions', exact: true })
  await expect(input).toBeVisible({ timeout: 15_000 })
  await expect(input).toBeFocused()
  expect((await activeElementInfo(orcaPage))?.isTerminalHelper).toBe(false)
})
