import { expect, it } from 'vitest'
import {
  AiVaultSearchSettingsSchema,
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  resolveAiVaultSearchSettings,
  sameAiVaultSearchSettings
} from './ai-vault-search-settings'

// Content is the only tier that needs consent: storing message bodies means
// reading every transcript on the machine, so a profile that has never answered
// must read as "no content". (Metadata — the history list's own rows — is always
// indexed, which is why there is no flag for it.)
it('reads anything that is not an explicit content opt-in as off', () => {
  expect(resolveAiVaultSearchSettings(undefined)).toEqual(DEFAULT_AI_VAULT_SEARCH_SETTINGS)
  expect(resolveAiVaultSearchSettings({})).toEqual(DEFAULT_AI_VAULT_SEARCH_SETTINGS)
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: null })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: { contentEnabled: 'yes' } })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: 'on' })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
})

// The field was named `enabled` before the metadata tier existed, and it named
// exactly the consent `contentEnabled` names now. Resetting it would silently
// re-open a question the user already answered, and the index would stop
// answering content searches for no reason the user could see.
it('carries a pre-tier opt-in over to the content flag', () => {
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: 30 } })
  ).toEqual({ contentEnabled: true, historyDays: 30 })
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: false, historyDays: 30 } })
  ).toEqual({ contentEnabled: false, historyDays: 30 })
  // The new name wins when a profile somehow holds both.
  expect(
    resolveAiVaultSearchSettings({
      aiVaultSearch: { contentEnabled: false, enabled: true, historyDays: null }
    })
  ).toEqual({ contentEnabled: false, historyDays: null })
})

it('normalizes a history bound and drops anything that is not one', () => {
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { contentEnabled: true, historyDays: 30.7 } })
  ).toEqual({ contentEnabled: true, historyDays: 30 })
  // A fractional day floors to zero, which would read as "all history" on one
  // side and "cutoff is now" on the other.
  for (const historyDays of [0.4, 0, -30, Number.NaN] as const) {
    expect(
      resolveAiVaultSearchSettings({ aiVaultSearch: { contentEnabled: true, historyDays } })
    ).toEqual({ contentEnabled: true, historyDays: null })
  }
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { contentEnabled: true, historyDays: 999_999 } })
  ).toEqual({ contentEnabled: true, historyDays: 3_650 })
})

// There is no `paused`: the indexer is immutable, so a pause would be a second
// lifetime for one object's store, queue and sweep flag.
it('keeps only the two fields the indexer is constructed from', () => {
  expect(
    resolveAiVaultSearchSettings({
      aiVaultSearch: { contentEnabled: true, historyDays: 90, paused: true }
    })
  ).toEqual({ contentEnabled: true, historyDays: 90 })
})

it('accepts what it produces and refuses what it does not', () => {
  expect(AiVaultSearchSettingsSchema.parse({ contentEnabled: true, historyDays: 90 })).toEqual({
    contentEnabled: true,
    historyDays: 90
  })
  expect(
    AiVaultSearchSettingsSchema.safeParse({ contentEnabled: true, historyDays: 0 }).success
  ).toBe(false)
  expect(AiVaultSearchSettingsSchema.safeParse({ historyDays: null }).success).toBe(false)
})

it('treats an unchanged policy as unchanged so a re-save never restarts the index', () => {
  expect(
    sameAiVaultSearchSettings(
      { contentEnabled: true, historyDays: 30 },
      { contentEnabled: true, historyDays: 30 }
    )
  ).toBe(true)
  expect(
    sameAiVaultSearchSettings(
      { contentEnabled: true, historyDays: 30 },
      { contentEnabled: true, historyDays: 90 }
    )
  ).toBe(false)
  expect(
    sameAiVaultSearchSettings(
      { contentEnabled: true, historyDays: null },
      { contentEnabled: false, historyDays: null }
    )
  ).toBe(false)
})
