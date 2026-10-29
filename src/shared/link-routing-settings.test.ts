import { describe, expect, it } from 'vitest'
import { normalizeLinkRoutingDefaultInApp } from './link-routing-settings'

describe('normalizeLinkRoutingDefaultInApp', () => {
  it('turns a fresh profile on and stamps it', () => {
    expect(normalizeLinkRoutingDefaultInApp(undefined)).toEqual({
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true,
      openLinksInAppDefaultedOnForAllUsers: true
    })
  })

  // Pre-stamp profiles saved `false` because that was the old default, not because they chose it.
  it('overrides the old persisted default', () => {
    expect(
      normalizeLinkRoutingDefaultInApp({
        openLinksInApp: false,
        openLinksInAppPreferencePrompted: false
      })
    ).toEqual({
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true,
      openLinksInAppDefaultedOnForAllUsers: true
    })
  })

  it('preserves an opt-out made after the default changed', () => {
    expect(
      normalizeLinkRoutingDefaultInApp({
        openLinksInApp: false,
        openLinksInAppPreferencePrompted: true,
        openLinksInAppDefaultedOnForAllUsers: true
      }).openLinksInApp
    ).toBe(false)
  })

  it('keeps a stamped profile that left the default on', () => {
    expect(
      normalizeLinkRoutingDefaultInApp({
        openLinksInApp: true,
        openLinksInAppPreferencePrompted: true,
        openLinksInAppDefaultedOnForAllUsers: true
      }).openLinksInApp
    ).toBe(true)
  })
})
