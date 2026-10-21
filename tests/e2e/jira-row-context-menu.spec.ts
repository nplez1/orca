/**
 * The Jira card right-click menu, on both surfaces that render a card: the task list's
 * row and the board view's card. The actions are the ones the detail sheet declares, on
 * the card itself, without opening it.
 */

import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ISSUE_TITLE, openFixtureJiraList } from './helpers/jira-fixture'

const CARD_MENU_ITEMS = [
  'Start workspace',
  'Open in Jira',
  'Copy URL',
  'Copy key',
  'Copy suggested branch name',
  'Copy prompt'
]

async function expectCardMenu(page: Page, card: Locator): Promise<void> {
  await card.click({ button: 'right' })
  for (const name of CARD_MENU_ITEMS) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible()
  }
  // The menu is additive: right-click must not activate or navigate the card.
  await expect(card).toBeVisible()
  await expect(card).not.toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
}

/** Activation really does replace the card with the detail view, so the checks above
 *  cannot pass vacuously on a card that is never clickable. */
async function expectActivationOpens(card: Locator): Promise<void> {
  await card.click()
  await expect(card).toBeHidden()
}

test('right-clicking a Jira task row opens its actions menu without opening the row', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)
  const row = orcaPage.getByRole('button', { name: new RegExp(ISSUE_TITLE) })
  await expect(row).toBeVisible()
  await expectCardMenu(orcaPage, row)
  await expectActivationOpens(row)
})

test('right-clicking a Jira board card opens the same menu without opening the card', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Board', exact: true }).click()
  const card = orcaPage.getByRole('button', { name: new RegExp(ISSUE_TITLE) })
  await expect(card).toBeVisible()
  await expectCardMenu(orcaPage, card)
  await expectActivationOpens(card)
})
