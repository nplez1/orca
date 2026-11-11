import { describe, expect, it } from 'vitest'
import {
  detectGitRemoteTransport,
  rewriteGitRemoteTransport,
  type GitRemoteTransport
} from './git-remote-url-transport'

describe('detectGitRemoteTransport', () => {
  it.each([
    ['git@github.com:acme/app.git', 'ssh'],
    ['ssh://git@github.com/acme/app.git', 'ssh'],
    ['https://github.com/acme/app.git', 'https'],
    ['http://gitlab.example.com/group/app.git', 'https']
  ])('reads %s as %s', (url, transport) => {
    expect(detectGitRemoteTransport(url)).toBe(transport)
  })

  it.each([
    ['/Users/alice/code/app'],
    ['~/code/app'],
    ['C:\\code\\app'],
    ['../sibling'],
    ['file:///srv/git/app.git'],
    ['git://github.com/acme/app.git'],
    ['devbox:acme/app.git'],
    ['https://github.com'],
    ['https://github.com/acme/app.git?ref=main']
  ])('has no counterpart for %s', (url) => {
    expect(detectGitRemoteTransport(url)).toBeNull()
  })
})

describe('rewriteGitRemoteTransport', () => {
  const cases: [url: string, to: GitRemoteTransport, expected: string][] = [
    ['git@github.com:acme/app.git', 'https', 'https://github.com/acme/app.git'],
    ['https://github.com/acme/app.git', 'ssh', 'git@github.com:acme/app.git'],
    ['git@gitlab.com:group/sub/app.git', 'https', 'https://gitlab.com/group/sub/app.git'],
    ['https://gitlab.com/group/sub/app.git', 'ssh', 'git@gitlab.com:group/sub/app.git'],
    ['git@bitbucket.org:acme/app', 'https', 'https://bitbucket.org/acme/app'],
    ['ssh://git@ssh.github.com:443/acme/app.git', 'https', 'https://github.com/acme/app.git'],
    ['https://altssh.gitlab.com/group/app.git', 'ssh', 'git@gitlab.com:group/app.git'],
    ['https://token@github.com/acme/app.git', 'ssh', 'git@github.com:acme/app.git'],
    ['ssh://git@github.com:2222/acme/app.git', 'https', 'https://github.com/acme/app.git']
  ]

  it.each(cases)('rewrites %s to %s', (url, to, expected) => {
    expect(rewriteGitRemoteTransport(url, to)).toBe(expected)
  })

  it('returns the url unchanged when it already has the requested transport', () => {
    expect(rewriteGitRemoteTransport('https://github.com/acme/app.git', 'https')).toBe(
      'https://github.com/acme/app.git'
    )
  })

  it('never emits credentials in either direction', () => {
    expect(rewriteGitRemoteTransport('https://user:pw@github.com/acme/app.git', 'https')).toBe(
      'https://github.com/acme/app.git'
    )
    expect(rewriteGitRemoteTransport('git@github.com:acme/app.git', 'https')).not.toContain('@')
  })

  it('leaves an Azure DevOps remote alone, whose path differs per transport', () => {
    expect(
      rewriteGitRemoteTransport('https://dev.azure.com/org/project/_git/app', 'ssh')
    ).toBeNull()
  })
})
