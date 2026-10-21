/**
 * The Jira task row's right-click menu: the actions the detail sheet declares, on the
 * row itself, without opening the row.
 */

import { expect, test } from './helpers/orca-app'
import { ISSUE_TITLE, openFixtureJiraList } from './helpers/jira-fixture'

const ROW_MENU_ITEMS = [
  'Start workspace',
  'Open in Jira',
  'Copy URL',
  'Copy key',
  'Copy suggested branch name',
  'Copy prompt'
]

test('right-clicking a Jira task row opens its actions menu without opening the row', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)
  const row = orcaPage.getByRole('button', { name: new RegExp(ISSUE_TITLE) })
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  for (const name of ROW_MENU_ITEMS) {
    await expect(orcaPage.getByRole('menuitem', { name, exact: true })).toBeVisible()
  }
  // The menu is additive: right-click must not also activate the row.
  await expect(row).not.toHaveAttribute('aria-current', 'true')
})
