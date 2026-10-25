import { expect, test } from './helpers/orca-app'
import { ISSUE_TITLE, openFixtureJiraList } from './helpers/jira-fixture'

test('Jira titles and sort headings adapt to panel width inside a wide window', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)

  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  // Why the md and lg steps measure 860 and 1060 rather than this test's original 780 and
  // 1050: this fork shows the story-points column by default, which widens the row's
  // minimum to 830px at the md tier and 1032px at the lg tier (measured in the app), so a
  // panel just above the 768/1024 breakpoints scrolls sideways — 770-844 at md (73px down
  // to 1px) and 1026-1044 at lg (19px down to 1px), with everything from 845 and 1045
  // fitting, and 1024-1025 still on the md tier. The two steps below are inside their tier
  // and wide enough for the default set to fit, which is what the fit check asserts; 780
  // only ever asserted the title floor, and its original 200px expectation already failed
  // there with upstream's columns on a machine with a stable scrollbar gutter (189px
  // measured).
  let previousDesktopTitleWidth: number | null = null
  for (const width of [500, 860, 1060, 1320]) {
    const panelWidth = await title.evaluate((element, width) => {
      const host =
        element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement
          ?.parentElement?.parentElement
      if (!(host instanceof HTMLElement)) {
        throw new Error('Jira list host unavailable')
      }
      host.style.width = `${width}px`
      host.style.maxWidth = 'none'
      return host.getBoundingClientRect().width
    }, width)
    expect(panelWidth).toBe(width)
    // Why the md and lg steps assert the grid's own title floor rather than the 200px
    // this test was calibrated on: with the points column on by default the row's minimum
    // is 830px at md and 1032px at lg, so the title comes close to minmax(180px, 1fr) there
    // — measured 197 at 860 and 195 at 1060, against 337 at 500 and 367 at 1320. The floor
    // is still what the readable-title guarantee means at those widths.
    const minimumTitleWidth = width >= 768 && width < 1280 ? 180 : 200
    await expect
      .poll(() => title.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThanOrEqual(minimumTitleWidth)
    // And the row has to fit at every step: 17px of slack at 860, 13px at 1060, and the
    // whole panel at the two ends.
    expect(
      await title.evaluate((element) => {
        const row = element.closest('[role="button"]')
        const scroll = row?.parentElement?.parentElement?.parentElement?.parentElement
        if (!(row instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
          throw new Error('Jira list scroll container unavailable')
        }
        return scroll.scrollWidth - scroll.clientWidth
      })
    ).toBeLessThanOrEqual(0)
    const mobileSort = orcaPage.getByTestId('jira-mobile-sort-controls')
    const assignee = orcaPage.getByRole('button', { name: 'Assignee', exact: true })
    await (width < 768 ? expect(mobileSort).toBeVisible() : expect(mobileSort).toBeHidden())
    await (width >= 1024 ? expect(assignee).toBeVisible() : expect(assignee).toBeHidden())
    if (width >= 768) {
      const grids = await title.evaluate((element) => {
        const row = element.closest('[role="button"]')
        const host = row?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement
        const header = host?.querySelector('button[aria-pressed]')?.parentElement
        if (!row || !header) {
          throw new Error('Jira header or row unavailable')
        }
        return [
          getComputedStyle(row).gridTemplateColumns.split(' '),
          getComputedStyle(header).gridTemplateColumns.split(' ')
        ]
      })
      // The scroll gutter narrows the flexible title; fixed tracks must still match.
      expect(grids[0].filter((_, index) => index !== 1)).toEqual(
        grids[1].filter((_, index) => index !== 1)
      )
      const titleWidth = await title.evaluate((element) => element.getBoundingClientRect().width)
      if (previousDesktopTitleWidth !== null) {
        expect(titleWidth).toBeGreaterThan(previousDesktopTitleWidth)
      }
      previousDesktopTitleWidth = titleWidth
    }
  }
})

test('Jira planning columns persist and hiding a sorted field selects a visible fallback', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)
  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  await title.evaluate((element) => {
    const host =
      element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement?.parentElement
        ?.parentElement
    if (!(host instanceof HTMLElement)) {
      throw new Error('Jira list host unavailable')
    }
    host.style.width = '780px'
  })
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  // Points is on by default here (a deliberate divergence from upstream, which hides
  // every planning column), so only the genuinely hidden ones are switched on.
  for (const name of ['Parent', 'Sprint', 'Estimate', 'Remaining']) {
    await orcaPage.getByRole('menuitemcheckbox', { name, exact: true }).click()
  }
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByText('Epic planning', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Sprint 12', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('2h', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('30m', { exact: true })).toBeVisible()
  const layout = await title.evaluate((element) => {
    const row = element.closest('[role="button"]')
    const scroll = row?.parentElement?.parentElement?.parentElement?.parentElement
    if (!(scroll instanceof HTMLElement)) {
      throw new Error('Scroll container unavailable')
    }
    return {
      title: element.getBoundingClientRect().width,
      content: scroll.scrollWidth,
      viewport: scroll.clientWidth
    }
  })
  expect(layout.title).toBeGreaterThanOrEqual(180)
  expect(layout.content).toBeGreaterThan(layout.viewport)
  await orcaPage.getByRole('button', { name: 'Points', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: 'Points, ascending' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  await orcaPage.getByRole('menuitemcheckbox', { name: 'Points', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('button', { name: 'Updated, descending' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await orcaPage.reload()
  await openFixtureJiraList(orcaPage)
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  await expect(
    orcaPage.getByRole('menuitemcheckbox', { name: 'Sprint', exact: true })
  ).toHaveAttribute('aria-checked', 'true')
  await expect(
    orcaPage.getByRole('menuitemcheckbox', { name: 'Points', exact: true })
  ).toHaveAttribute('aria-checked', 'false')
})
