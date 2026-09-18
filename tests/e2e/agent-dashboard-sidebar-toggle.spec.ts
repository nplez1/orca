import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

// Why: every window here stays hidden and Playwright drives the renderers over
// CDP, so this run can never take the desktop's focus away from the user.
test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const SHEET = '[data-agent-dashboard-sheet]'
const ENTRY = 'button[data-contextual-tour-target="agents-sidebar"]'
const SETTINGS_MENU_LABEL = 'Agent Dashboard settings'

function dashboardEntry(page: Page) {
  return page.locator(ENTRY)
}

test('the sidebar entry tracks and toggles whichever dashboard surface is showing', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    await store.getState().updateSettings({
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardMode: 'in-window',
      experimentalAgentDashboardShowIdle: true
    })
  })

  const entry = dashboardEntry(orcaPage)
  await expect(entry).toBeVisible()
  await expect(entry).toHaveAttribute('aria-pressed', 'false')
  const unselectedBackground = await entry.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  expect(unselectedBackground).toBe('rgba(0, 0, 0, 0)')

  // In-window: the entry is selected exactly while the drawer is showing.
  await entry.click()
  await expect(orcaPage.locator(SHEET)).toBeVisible()
  await expect(entry).toHaveAttribute('aria-pressed', 'true')
  await expect(entry).toHaveAttribute('data-current', 'true')
  // The selected state has to be visible, not just announced to assistive tech.
  expect(await entry.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    unselectedBackground
  )

  await entry.click()
  await expect(orcaPage.locator(SHEET)).toBeHidden()
  await expect(entry).toHaveAttribute('aria-pressed', 'false')
  await expect(entry).not.toHaveAttribute('data-current', 'true')

  // Pop-out: switching from the board's own settings menu hands the board to
  // the second window, and the entry follows it there.
  await entry.click()
  await expect(orcaPage.locator(SHEET)).toBeVisible()
  const popoutWindowPromise = electronApp.waitForEvent('window')
  await orcaPage.getByRole('button', { name: SETTINGS_MENU_LABEL }).click()
  await orcaPage.getByRole('radio', { name: 'Pop-out' }).click()

  const popout = await popoutWindowPromise
  const popoutSettings = popout.getByRole('button', { name: SETTINGS_MENU_LABEL })
  await expect(popoutSettings).toBeVisible()
  await expect(entry).toHaveAttribute('aria-pressed', 'true')

  // The pop-out is the only place the mode can be changed back, so it must
  // offer the same menu — and choosing In-window must return the board to the
  // main window rather than dropping it.
  const popoutClosed = popout.waitForEvent('close')
  await popoutSettings.click()
  await popout.getByRole('radio', { name: 'In-window' }).click()
  await popoutClosed

  await expect(orcaPage.locator(SHEET)).toBeVisible()
  await expect(entry).toHaveAttribute('aria-pressed', 'true')

  // Still a toggle: the entry hides the in-window board it just restored.
  await entry.click()
  await expect(orcaPage.locator(SHEET)).toBeHidden()
  await expect(entry).toHaveAttribute('aria-pressed', 'false')
})
