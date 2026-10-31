import { describe, expect, it } from 'vitest'
import { sanitizeGitRemoteIdentity, sanitizeRepoUpdatesForPersistence } from './repo-sanitization'

const forkIdentity = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'upstream',
  remoteUrl: 'https://github.com/stablyai/orca.git',
  remoteKeys: ['github.com/stablyai/orca', 'github.com/nplez1/orca']
}

describe('git remote identity persistence', () => {
  it('keeps every remote key so a fork stays linkable after a reload', () => {
    // Why: dropping the other remotes here unreaches the fork's own repository — the probe writes
    // this value on one side of the store and the link scope checks read it on the other.
    expect(sanitizeGitRemoteIdentity(forkIdentity)).toEqual(forkIdentity)
  })

  it('drops an absent key list rather than writing an empty one', () => {
    expect(
      sanitizeGitRemoteIdentity({
        canonicalKey: 'github.com/acme/repo',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/acme/repo.git'
      })
    ).toEqual({
      canonicalKey: 'github.com/acme/repo',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/repo.git'
    })
    expect(
      sanitizeGitRemoteIdentity({
        canonicalKey: 'github.com/acme/repo',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/acme/repo.git',
        remoteKeys: []
      })
    ).not.toHaveProperty('remoteKeys')
  })

  it('trims, de-duplicates and discards non-string keys', () => {
    expect(
      sanitizeGitRemoteIdentity({
        canonicalKey: 'github.com/acme/repo',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/acme/repo.git',
        remoteKeys: [' github.com/acme/repo ', 'github.com/fork/repo', 'github.com/acme/repo', 7, '']
      })
    ).toEqual({
      canonicalKey: 'github.com/acme/repo',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/repo.git',
      remoteKeys: ['github.com/acme/repo', 'github.com/fork/repo']
    })
  })

  it('carries the keys through an update write', () => {
    const updates = sanitizeRepoUpdatesForPersistence({ gitRemoteIdentity: forkIdentity })
    expect(updates.gitRemoteIdentity).toEqual(forkIdentity)
  })

  it('still rejects an identity missing its primary fields', () => {
    expect(sanitizeGitRemoteIdentity({ remoteKeys: ['github.com/acme/repo'] })).toBeUndefined()
  })
})
