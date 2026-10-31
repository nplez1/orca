import { describe, expect, it } from 'vitest'
import { normalizeGitHubRemoteHost } from './git-remote-host-alias'
import {
  deriveGitRemoteIdentity,
  gitRemoteIdentityKeys,
  matchGitRemoteKeyParts,
  normalizeGitRemoteUrl,
  splitGitRemoteKey
} from './git-remote-identity'

describe('normalizeGitRemoteUrl', () => {
  it('normalizes HTTPS and SSH GitHub remotes to the same canonical key', () => {
    expect(normalizeGitRemoteUrl('https://github.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('git@github.com:example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('ssh://git@github.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('https://GitHub.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
  })

  it('preserves nested GitLab/self-hosted paths', () => {
    expect(normalizeGitRemoteUrl('git@gitlab.company.test:platform/tools/sample-app.git')).toBe(
      'gitlab.company.test/platform/tools/sample-app'
    )
  })

  it('ignores explicit URL ports in canonical keys', () => {
    expect(normalizeGitRemoteUrl('ssh://git@git.company.test:2222/team/sample-app.git')).toBe(
      'git.company.test/team/sample-app'
    )
  })

  it('preserves path case for case-sensitive hosted remotes', () => {
    expect(normalizeGitRemoteUrl('git@Git.Company.Test:Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
    expect(normalizeGitRemoteUrl('https://git.company.test/Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
  })

  it('rejects Windows local filesystem remotes', () => {
    expect(normalizeGitRemoteUrl('C:\\Repos\\sample-app.git')).toBeNull()
    expect(normalizeGitRemoteUrl('C:/Repos/sample-app.git')).toBeNull()
  })
})

describe('deriveGitRemoteIdentity', () => {
  it.each(['blob:none', 'blob:limit=1024', 'tree:0'])(
    'prefers a partial-clone origin with filter %s over contributor remotes',
    (filter) => {
      expect(
        deriveGitRemoteIdentity(
          [
            'amoaba\thttps://github.com/AmoabaKelvin/orca.git (fetch)',
            `origin\thttps://github.com/stablyai/orca.git (fetch) [${filter}]`,
            'origin\thttps://github.com/another/orca.git (push)'
          ].join('\r\n')
        )
      ).toEqual({
        canonicalKey: 'github.com/stablyai/orca',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/stablyai/orca.git',
        remoteKeys: ['github.com/stablyai/orca', 'github.com/AmoabaKelvin/orca']
      })
    }
  )

  it('keeps a fork’s own repository alongside the parent it prefers', () => {
    // fork-comment-ok: fork-only behaviour; the why must sit above the code a sync rewrites.
    // Why: the canonical key is the fork parent, but a fork's issues live on origin — dropping it
    // makes the user's own issues read as another repository's when they attach one.
    expect(
      deriveGitRemoteIdentity(
        [
          'origin\tgit@github.com:nplez1/orca.git (fetch)',
          'origin\tgit@github.com:nplez1/orca.git (push)',
          'upstream\thttps://github.com/stablyai/orca.git (fetch)',
          'upstream\thttps://github.com/stablyai/orca.git (push)'
        ].join('\n')
      )
    ).toEqual({
      canonicalKey: 'github.com/stablyai/orca',
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/stablyai/orca.git',
      remoteKeys: ['github.com/stablyai/orca', 'github.com/nplez1/orca']
    })
    expect(
      gitRemoteIdentityKeys({
        canonicalKey: 'github.com/stablyai/orca',
        remoteKeys: ['github.com/stablyai/orca', 'github.com/nplez1/orca']
      })
    ).toEqual(['github.com/stablyai/orca', 'github.com/nplez1/orca'])
    expect(gitRemoteIdentityKeys({ canonicalKey: 'github.com/acme/repo' })).toEqual([
      'github.com/acme/repo'
    ])
    expect(gitRemoteIdentityKeys(null)).toEqual([])
  })

  it('prefers upstream, then origin, then the first named remote', () => {
    expect(
      deriveGitRemoteIdentity(
        [
          'origin\tgit@git.company.test:forks/sample-app.git (fetch)',
          'origin\tgit@git.company.test:forks/sample-app.git (push)',
          'upstream\thttps://git.company.test/team/sample-app.git (fetch)',
          'upstream\thttps://git.company.test/team/sample-app.git (push)'
        ].join('\n')
      )
    ).toEqual({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'upstream',
      remoteUrl: 'https://git.company.test/team/sample-app.git',
      remoteKeys: ['git.company.test/team/sample-app', 'git.company.test/forks/sample-app']
    })

    expect(
      deriveGitRemoteIdentity('origin\tgit@git.company.test:team/sample-app.git (fetch)')
    ).toMatchObject({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'origin'
    })

    expect(
      deriveGitRemoteIdentity('mirror\tgit@git.company.test:team/sample-app.git (fetch)')
    ).toMatchObject({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'mirror'
    })
  })
})

describe('splitGitRemoteKey / matchGitRemoteKeyParts', () => {
  const github = (key: string | undefined) => splitGitRemoteKey(key, normalizeGitHubRemoteHost)

  it('rejects keys without both a host and a path', () => {
    expect(github('github.com')).toBeNull()
    expect(github('github.com/')).toBeNull()
    expect(github('/example/sample-app')).toBeNull()
    expect(github(undefined)).toBeNull()
  })

  it('normalizes the host and lowercases the path tail', () => {
    expect(github('SSH.GitHub.com:443/Example/Sample-App')).toEqual({
      host: 'github.com',
      tail: 'example/sample-app'
    })
  })

  it('treats a dotless probed host as unknown but a real host as a mismatch', () => {
    const target = { host: 'github.com', tail: 'example/sample-app' }
    expect(matchGitRemoteKeyParts({ host: 'github-work', tail: target.tail }, target)).toBe(
      'unknown'
    )
    expect(matchGitRemoteKeyParts({ host: 'ghe.example.com', tail: target.tail }, target)).toBe(
      false
    )
    expect(matchGitRemoteKeyParts({ host: 'github-work', tail: 'other/repo' }, target)).toBe(false)
  })
})
