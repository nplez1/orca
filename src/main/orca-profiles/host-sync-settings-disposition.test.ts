import { describe, expect, it } from 'vitest'
import {
  GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION,
  SETTINGS_FIELDS_HOST_LOCAL,
  SETTINGS_FIELDS_REPLICATED_ONLY_IF_EMPTY,
  SETTINGS_FIELDS_REPLICATED_TO_HOSTS
} from './host-sync-settings-disposition'

/**
 * Why the census does not spell out every membership: the table is 245 explicit lines, so a
 * reclassification is a one-word diff a reviewer reads directly. What a test has to catch is a field
 * that reaches *no* list, and a key the table forgot — the first is the partition below, the second is
 * a compile error from the table's `satisfies Record<keyof GlobalSettings, …>`.
 */
describe('global settings host-sync disposition census', () => {
  it('classifies every setting into exactly one of the three lists', () => {
    const classified = [
      ...SETTINGS_FIELDS_HOST_LOCAL,
      ...SETTINGS_FIELDS_REPLICATED_TO_HOSTS,
      ...SETTINGS_FIELDS_REPLICATED_ONLY_IF_EMPTY
    ]

    expect(new Set(classified).size).toBe(classified.length)
    expect(classified.length).toBe(Object.keys(GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION).length)
  })

  it('carries no value outside the three dispositions', () => {
    const unknown = Object.entries(GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION).filter(
      ([, disposition]) =>
        disposition !== 'replicated' &&
        disposition !== 'hostLocal' &&
        disposition !== 'replicatedOnlyIfEmpty'
    )

    expect(unknown).toEqual([])
  })

  it('keeps the accumulated-state list short, and names it', () => {
    // The only list small enough to name outright. Everything else here is a deliberate preference
    // (replicated) or a fact about one machine (hostLocal), and both are read from the table itself.
    expect(SETTINGS_FIELDS_REPLICATED_ONLY_IF_EMPTY).toEqual([
      'localBaseRefSuggestionDismissed',
      'openLinksInAppPreferencePrompted',
      'dismissedSkillFreshnessNudges',
      'agentsSidebarIntroShown'
    ])
  })

  it('keeps both larger groups non-empty', () => {
    // A guard against a table that classified everything one way: `replicated` with no `hostLocal`
    // would replicate this machine's shell and paths, and `hostLocal` with no `replicated` would make
    // the whole feature a no-op.
    expect(SETTINGS_FIELDS_HOST_LOCAL.length).toBeGreaterThan(0)
    expect(SETTINGS_FIELDS_REPLICATED_TO_HOSTS.length).toBeGreaterThan(0)
  })
})
