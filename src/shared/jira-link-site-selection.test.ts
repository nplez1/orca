import { describe, expect, it } from 'vitest'
import { selectJiraLinkSite } from './jira-link-site-selection'
import type { JiraSite } from './jira-types'

function site(id: string, siteUrl = `https://${id}.atlassian.net`): JiraSite {
  return { id, siteUrl, email: `${id}@example.com`, displayName: id, accountId: id }
}

const ACME = site('acme')
const OTHER = site('other')

describe('selectJiraLinkSite', () => {
  it('reports no connection before anything else', () => {
    expect(selectJiraLinkSite({ siteUrl: 'https://acme.atlassian.net', sites: [] })).toEqual({
      ok: false,
      reason: 'no-sites'
    })
    expect(selectJiraLinkSite({ siteUrl: null, sites: [] })).toEqual({
      ok: false,
      reason: 'no-sites'
    })
  })

  it('takes the site an issue URL names, even when another is selected', () => {
    expect(
      selectJiraLinkSite({
        siteUrl: 'https://other.atlassian.net',
        sites: [ACME, OTHER],
        selectedSiteId: 'acme'
      })
    ).toEqual({ ok: true, site: OTHER })
  })

  it('matches a URL to a site with a path and a trailing slash', () => {
    const host = site('host', 'https://jira.example.com/jira')
    expect(selectJiraLinkSite({ siteUrl: 'https://jira.example.com/jira', sites: [host] })).toEqual(
      { ok: true, site: host }
    )
  })

  it('rejects a URL for a site this host does not have', () => {
    expect(selectJiraLinkSite({ siteUrl: 'https://other.atlassian.net', sites: [ACME] })).toEqual({
      ok: false,
      reason: 'site-not-connected'
    })
  })

  it('breaks a shared-site tie only with the site the workspace already uses', () => {
    const second = site('acme-2', 'https://acme.atlassian.net')
    expect(
      selectJiraLinkSite({
        siteUrl: 'https://acme.atlassian.net',
        sites: [ACME, second],
        linkedSiteId: 'acme-2'
      })
    ).toEqual({ ok: true, site: second })
    expect(
      selectJiraLinkSite({ siteUrl: 'https://acme.atlassian.net', sites: [ACME, second] })
    ).toEqual({ ok: false, reason: 'ambiguous-site' })
  })

  it('resolves a bare key from the linked, then selected, then only site', () => {
    expect(
      selectJiraLinkSite({ siteUrl: null, sites: [ACME, OTHER], linkedSiteId: 'other' })
    ).toEqual({ ok: true, site: OTHER })
    expect(
      selectJiraLinkSite({ siteUrl: null, sites: [ACME, OTHER], selectedSiteId: 'other' })
    ).toEqual({ ok: true, site: OTHER })
    expect(selectJiraLinkSite({ siteUrl: null, sites: [ACME] })).toEqual({ ok: true, site: ACME })
  })

  it('treats an "all sites" selection as no selection', () => {
    expect(
      selectJiraLinkSite({ siteUrl: null, sites: [ACME, OTHER], selectedSiteId: 'all' })
    ).toEqual({ ok: false, reason: 'site-unresolved' })
  })

  // Why: resolving the key elsewhere would move a live link to an issue the user
  // never named.
  it('fails a bare key whose linked site is gone rather than falling through', () => {
    expect(
      selectJiraLinkSite({
        siteUrl: null,
        sites: [ACME],
        selectedSiteId: 'acme',
        linkedSiteId: 'gone'
      })
    ).toEqual({ ok: false, reason: 'linked-site-disconnected' })
  })

  it('requires the URL when a bare key could belong to either site', () => {
    expect(selectJiraLinkSite({ siteUrl: null, sites: [ACME, OTHER] })).toEqual({
      ok: false,
      reason: 'site-unresolved'
    })
  })
})
