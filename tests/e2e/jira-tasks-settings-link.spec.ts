import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('Jira Tasks settings link opens the board settings section', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Settings are not available')
    }
    store.setState({
      settings: {
        ...settings,
        defaultTaskSource: 'jira',
        visibleTaskProviders: ['github', 'gitlab', 'linear', 'jira']
      }
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  })

  await expect(orcaPage.getByRole('button', { name: 'Jira task settings' })).toBeVisible({
    timeout: 10_000
  })
  await orcaPage.getByRole('button', { name: 'Jira task settings' }).click()

  await expect.poll(async () => getStoreState<string>(orcaPage, 'activeView')).toBe('settings')
  await expect(orcaPage.locator('[data-settings-section="tasks-jira-board"]')).toBeVisible({
    timeout: 10_000
  })
  await expect(orcaPage.getByRole('combobox', { name: 'Default board' })).toBeVisible({
    timeout: 10_000
  })
})
