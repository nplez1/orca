import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

// Why: every window here stays hidden and Playwright drives the renderers over
// CDP, so this run can never take the desktop's focus away from the user.
test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const DASHBOARD_PAGE = '[data-agent-dashboard-page]'
const ENTRY = 'button[data-contextual-tour-target="agents-sidebar"]'

function dashboardEntry(page: Page) {
  return page.locator(ENTRY)
}

test('the sidebar entry is a first-class dashboard view with a back-stack entry', async ({
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
      experimentalAgentDashboardShowIdle: true
    })
  })

  const entry = dashboardEntry(orcaPage)
  await expect(entry).toBeVisible()
  await expect(entry).not.toHaveAttribute('aria-current', 'page')
  const unselectedBackground = await entry.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  expect(unselectedBackground).toBe('rgba(0, 0, 0, 0)')

  // A back entry only lights up with somewhere to return to, so visit another page first.
  await orcaPage.locator('button[data-contextual-tour-target="sidebar-tasks"]').click()

  await entry.click()
  await expect(orcaPage.locator(DASHBOARD_PAGE)).toBeVisible()
  await expect(entry).toHaveAttribute('aria-current', 'page')
  await expect(entry).toHaveAttribute('data-current', 'true')
  // The selected state has to be visible, not just announced to assistive tech.
  expect(await entry.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    unselectedBackground
  )
  // Switching to the dashboard records a back-stack entry, like Tasks/Automations.
  expect(
    await orcaPage.evaluate(() =>
      window.__store?.getState().worktreeNavHistory.includes('dashboard')
    )
  ).toBe(true)

  // The dashboard has no close control: the shared back control is its way out, and using
  // it returns to the previous view and drops the selected state.
  await orcaPage.getByRole('button', { name: 'Go back' }).click()
  await expect(orcaPage.locator(DASHBOARD_PAGE)).toBeHidden()
  await expect(entry).not.toHaveAttribute('aria-current', 'page')
  await expect(entry).not.toHaveAttribute('data-current', 'true')
})
