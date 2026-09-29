import { describe, expect, it } from 'vitest'
import {
  isUsageProviderDisabled,
  normalizeDisabledUsageProviders,
  withUsageProviderDisabled
} from './usage-provider-enablement'

describe('normalizeDisabledUsageProviders', () => {
  it('keeps only known provider ids', () => {
    expect(normalizeDisabledUsageProviders(['cursor', 'not-a-provider', 42, null])).toEqual([
      'cursor'
    ])
  })

  it('deduplicates and restores the canonical order', () => {
    expect(normalizeDisabledUsageProviders(['cursor', 'claude', 'cursor'])).toEqual([
      'claude',
      'cursor'
    ])
  })

  it('treats a non-array value as nothing disabled', () => {
    expect(normalizeDisabledUsageProviders(undefined)).toEqual([])
    expect(normalizeDisabledUsageProviders('cursor')).toEqual([])
    expect(normalizeDisabledUsageProviders({ cursor: true })).toEqual([])
  })
})

describe('withUsageProviderDisabled', () => {
  it('adds a provider while preserving canonical order', () => {
    expect(withUsageProviderDisabled(['grok'], 'claude', true)).toEqual(['claude', 'grok'])
  })

  it('removes a provider', () => {
    expect(withUsageProviderDisabled(['claude', 'grok'], 'claude', false)).toEqual(['grok'])
  })

  it('is a no-op when the desired state already holds', () => {
    expect(withUsageProviderDisabled(['cursor'], 'cursor', true)).toEqual(['cursor'])
    expect(withUsageProviderDisabled([], 'cursor', false)).toEqual([])
  })
})

describe('isUsageProviderDisabled', () => {
  it('reads the persisted disabled set, defaulting to enabled', () => {
    expect(isUsageProviderDisabled(['gemini'], 'gemini')).toBe(true)
    expect(isUsageProviderDisabled(['gemini'], 'cursor')).toBe(false)
    expect(isUsageProviderDisabled(undefined, 'cursor')).toBe(false)
    expect(isUsageProviderDisabled(null, 'cursor')).toBe(false)
  })
})
