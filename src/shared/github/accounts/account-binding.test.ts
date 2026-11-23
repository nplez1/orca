import { describe, expect, it } from 'vitest'
import {
  ghAccountBindingsEqual,
  isAppGhAccountBinding,
  normalizeGhAccountBinding
} from './account-binding'

describe('normalizeGhAccountBinding', () => {
  it('keeps a binding written before Apps existed a user binding', () => {
    expect(normalizeGhAccountBinding({ host: 'GitHub.com', user: 'octocat' })).toEqual({
      host: 'github.com',
      user: 'octocat'
    })
  })

  it('drops an explicit user kind, so an old and a new record compare as one binding', () => {
    expect(
      normalizeGhAccountBinding({ host: 'github.com', user: 'octocat', kind: 'user' })
    ).toEqual({ host: 'github.com', user: 'octocat' })
  })

  it('keeps an App binding, whose login is the App’s `<slug>[bot]`', () => {
    const binding = normalizeGhAccountBinding({
      host: 'github.com',
      user: 'lab-agent-np[bot]',
      kind: 'app'
    })
    expect(binding).toEqual({ host: 'github.com', user: 'lab-agent-np[bot]', kind: 'app' })
    expect(isAppGhAccountBinding(binding)).toBe(true)
  })

  it('refuses a kind it does not know rather than guessing an identity', () => {
    expect(
      normalizeGhAccountBinding({ host: 'github.com', user: 'octocat', kind: 'bot' })
    ).toBeNull()
  })
})

describe('ghAccountBindingsEqual', () => {
  it('treats an App and a login sharing host and name as different identities', () => {
    expect(
      ghAccountBindingsEqual(
        { host: 'github.com', user: 'orca[bot]', kind: 'app' },
        { host: 'github.com', user: 'orca[bot]' }
      )
    ).toBe(false)
  })

  it('treats an absent kind as the user binding it has always meant', () => {
    expect(
      ghAccountBindingsEqual(
        { host: 'github.com', user: 'octocat' },
        { host: 'github.com', user: 'octocat', kind: 'user' }
      )
    ).toBe(true)
  })
})
