import { describe, expect, it } from 'vitest'
import type { JiraBoardSelection, JiraSite } from './jira-types'
import {
  addJiraBoardSelection,
  connectedJiraSiteIds,
  describeJiraBoardSelections,
  effectiveJiraBoardSet,
  jiraBoardSelectionKey,
  jiraBoardSettingsWrite,
  moveJiraBoardSelection,
  normalizeJiraBoardSelection,
  normalizeJiraBoardSet,
  removeJiraBoardSelection,
  resolveJiraSelectedBoard
} from './jira-board-selection'

const payments: JiraBoardSelection = { boardId: '1', siteId: 'site-a', name: 'Payments' }
const platform: JiraBoardSelection = { boardId: '2', siteId: 'site-b', name: 'Platform' }
const sites: JiraSite[] = [
  {
    id: 'site-a',
    siteUrl: 'https://a.example',
    email: 'a@example.com',
    displayName: 'Site A',
    accountId: 'account-a'
  },
  {
    id: 'site-b',
    siteUrl: 'https://b.example',
    email: 'b@example.com',
    displayName: 'Site B',
    accountId: 'account-b'
  }
]

describe('jira board selection keys', () => {
  it('keeps a site id containing the separator distinct from another site', () => {
    expect(jiraBoardSelectionKey({ siteId: 'a:b', boardId: 'c' })).not.toBe(
      jiraBoardSelectionKey({ siteId: 'a', boardId: 'b:c' })
    )
  })
})

describe('normalizing a stored board set', () => {
  it('drops malformed and duplicate entries and treats an empty set as sticky-all', () => {
    expect(
      normalizeJiraBoardSet([
        payments,
        { ...payments, name: 'Payments again' },
        { boardId: '', siteId: 'site-a' },
        { boardId: '3' },
        null,
        'nope'
      ])
    ).toEqual([payments])
    expect(normalizeJiraBoardSet([])).toBeNull()
    expect(normalizeJiraBoardSet('not an array')).toBeNull()
  })

  it('rejects a selection without both ids and trims the stored name', () => {
    expect(
      normalizeJiraBoardSelection({ boardId: ' 9 ', siteId: ' site-a ', name: '  x  ' })
    ).toEqual({ boardId: '9', siteId: 'site-a', name: 'x' })
    expect(normalizeJiraBoardSelection({ boardId: '9', siteId: '   ' })).toBeNull()
    expect(normalizeJiraBoardSelection({ boardId: '9', siteId: 'site-a', name: 42 })).toEqual({
      boardId: '9',
      siteId: 'site-a'
    })
  })
})

describe('the effective board set', () => {
  it('migrates a lone legacy board to a one-element set', () => {
    expect(effectiveJiraBoardSet({ defaultJiraBoards: null, defaultJiraBoard: payments })).toEqual([
      payments
    ])
    expect(effectiveJiraBoardSet({ defaultJiraBoard: null })).toBeNull()
  })

  it('keeps a legacy board another build wrote in front of the set instead of dropping it', () => {
    expect(
      effectiveJiraBoardSet({ defaultJiraBoards: [platform], defaultJiraBoard: payments })
    ).toEqual([payments, platform])
  })

  it('does not duplicate the mirrored board a set already contains', () => {
    expect(
      effectiveJiraBoardSet({ defaultJiraBoards: [payments, platform], defaultJiraBoard: payments })
    ).toEqual([payments, platform])
  })

  it('writes the first board as the mirrored single selection', () => {
    expect(jiraBoardSettingsWrite([payments, platform])).toEqual({
      defaultJiraBoards: [payments, platform],
      defaultJiraBoard: payments
    })
    expect(jiraBoardSettingsWrite([])).toEqual({ defaultJiraBoards: null, defaultJiraBoard: null })
  })
})

describe('resolving the board that shows', () => {
  it('prefers the remembered board when the saved set still contains it', () => {
    expect(
      resolveJiraSelectedBoard({
        savedBoards: [payments, platform],
        lastSelected: platform,
        connectedSiteIds: null
      })
    ).toEqual(platform)
  })

  it('falls back to the first saved board when the remembered one left the set', () => {
    expect(
      resolveJiraSelectedBoard({
        savedBoards: [payments],
        lastSelected: platform,
        connectedSiteIds: null
      })
    ).toEqual(payments)
  })

  it('skips saved boards on a site that is not reachable and keeps the user pick for later', () => {
    const reachableSite: JiraSite | undefined = sites[1]
    const connectedSiteIds = connectedJiraSiteIds(
      { connected: true, sites: reachableSite ? [reachableSite] : [] },
      true
    )
    expect(
      resolveJiraSelectedBoard({
        savedBoards: [payments, platform],
        lastSelected: payments,
        connectedSiteIds
      })
    ).toEqual(platform)
    expect(connectedJiraSiteIds({ connected: true, sites: [] }, true)).toBeNull()
    expect(connectedJiraSiteIds({ connected: true, sites }, false)).toBeNull()
  })

  it('shows nothing under sticky-all until a board has been picked', () => {
    expect(
      resolveJiraSelectedBoard({ savedBoards: null, lastSelected: null, connectedSiteIds: null })
    ).toBeNull()
    expect(
      resolveJiraSelectedBoard({
        savedBoards: null,
        lastSelected: payments,
        connectedSiteIds: null
      })
    ).toEqual(payments)
  })

  it('hides a remembered board whose own site is unreachable', () => {
    expect(
      resolveJiraSelectedBoard({
        savedBoards: null,
        lastSelected: payments,
        connectedSiteIds: new Set(['site-b'])
      })
    ).toBeNull()
  })

  it('does not bring a removed board back once the last saved board is gone', () => {
    // The pick was made from a curated set, so it belongs to that set, not to sticky-all.
    expect(
      resolveJiraSelectedBoard({
        savedBoards: null,
        lastSelected: platform,
        lastSelectedFromCuratedSet: true,
        connectedSiteIds: null
      })
    ).toBeNull()
    // A pick made while every board was offered is a free choice and does survive.
    expect(
      resolveJiraSelectedBoard({
        savedBoards: null,
        lastSelected: platform,
        lastSelectedFromCuratedSet: false,
        connectedSiteIds: null
      })
    ).toEqual(platform)
  })
})

describe('describing switcher options', () => {
  it('names the site and marks a board whose site is unreachable as stale', () => {
    expect(
      describeJiraBoardSelections({
        selections: [payments, { boardId: '7', siteId: 'site-b' }],
        sites,
        connectedSiteIds: new Set(['site-a'])
      })
    ).toEqual([
      { selection: payments, label: 'Payments', siteLabel: 'Site A', stale: false },
      {
        selection: { boardId: '7', siteId: 'site-b' },
        label: 'Board 7',
        siteLabel: 'Site B',
        stale: true
      }
    ])
  })
})

describe('editing the saved set', () => {
  it('appends without duplicating and removes by key', () => {
    expect(addJiraBoardSelection([payments], platform)).toEqual([payments, platform])
    expect(addJiraBoardSelection([payments], { ...payments, name: 'renamed' })).toEqual([payments])
    expect(removeJiraBoardSelection([payments, platform], jiraBoardSelectionKey(payments))).toEqual(
      [platform]
    )
  })

  it('moves an entry one place and refuses to fall off either end', () => {
    expect(
      moveJiraBoardSelection([payments, platform], jiraBoardSelectionKey(platform), -1)
    ).toEqual([platform, payments])
    expect(
      moveJiraBoardSelection([payments, platform], jiraBoardSelectionKey(payments), -1)
    ).toEqual([payments, platform])
    expect(
      moveJiraBoardSelection([payments, platform], jiraBoardSelectionKey(platform), 1)
    ).toEqual([payments, platform])
  })
})
