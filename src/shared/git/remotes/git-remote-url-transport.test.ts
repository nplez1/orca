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
    // Why kept: a path segment that merely happens to be `scm` is not Bitbucket Server's layout.
    ['https://gitlab.com/org/scm/app.git', 'ssh', 'git@gitlab.com:org/scm/app.git'],
    ['https://token@github.com/acme/app.git', 'ssh', 'git@github.com:acme/app.git'],
    ['ssh://git@github.com:22/acme/app.git', 'https', 'https://github.com/acme/app.git']
  ]

  it.each(cases)('rewrites %s to %s', (url, to, expected) => {
    expect(rewriteGitRemoteTransport(url, to)).toBe(expected)
  })

  it('returns the url untouched when it already has the requested transport', () => {
    // Why untouched rather than canonical: a port the user picked on purpose (ssh-over-443, a
    // self-hosted server on 2222) must survive a click on the transport that is already selected.
    expect(rewriteGitRemoteTransport('ssh://git@ssh.github.com:443/acme/app.git', 'ssh')).toBe(
      'ssh://git@ssh.github.com:443/acme/app.git'
    )
    expect(rewriteGitRemoteTransport('https://github.com/acme/app.git', 'https')).toBe(
      'https://github.com/acme/app.git'
    )
  })

  it('keeps a self-hosted ssh port out of the rewrite, since its path is unknown', () => {
    expect(
      rewriteGitRemoteTransport('ssh://git@gitlab.example.com:2222/g/a.git', 'https')
    ).toBeNull()
  })

  it('never invents a user on the way to https', () => {
    expect(rewriteGitRemoteTransport('https://user:pw@github.com/acme/app.git', 'ssh')).toBe(
      'git@github.com:acme/app.git'
    )
    expect(rewriteGitRemoteTransport('git@github.com:acme/app.git', 'https')).not.toContain('@')
  })

  const perTransportPaths: [url: string, to: GitRemoteTransport][] = [
    ['https://dev.azure.com/org/project/_git/app', 'ssh'],
    ['https://bitbucket.example.com/scm/PROJ/app.git', 'ssh'],
    ['https://bitbucket.example.com/bitbucket/scm/PROJ/app.git', 'ssh'],
    ['git@bitbucket.example.com:scm/PROJ/app.git', 'https'],
    // Why the port rule: a self-hosted server's ssh path is not derivable from an arbitrary port.
    ['ssh://git@bitbucket.example.com:7999/PROJ/app.git', 'https']
  ]

  it.each(perTransportPaths)('leaves %s alone, whose path differs per transport', (url, to) => {
    expect(rewriteGitRemoteTransport(url, to)).toBeNull()
  })
})
