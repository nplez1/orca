import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getRuntimeRepoTarget } from './repository-routing'

function makeRepo(id: string, path: string, executionHostId?: Repo['executionHostId']): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    ...(executionHostId ? { executionHostId } : {})
  }
}

const remoteTarget = { kind: 'environment', environmentId: 'env-1' } as const

describe('getRuntimeRepoTarget', () => {
  // Why: two machines can hold a checkout at the same path, and the first-wins path lookup used to
  // hand the server the other host's repo id, which it could not resolve.
  it('resolves the repo on the target host when another host shares its path', () => {
    const local = makeRepo('repo-local', '/repo')
    const remote = makeRepo('repo-runtime', '/repo', 'runtime:env-1')

    expect(
      getRuntimeRepoTarget({ repos: [local, remote] }, '/repo', remoteTarget, 'repo-runtime')?.repo
    ).toBe(remote)
  })

  it('prefers the id on the host over a different row that shares the path', () => {
    const byPath = makeRepo('other', '/repo', 'runtime:env-1')
    const byId = makeRepo('repo-runtime', '/elsewhere', 'runtime:env-1')

    expect(
      getRuntimeRepoTarget({ repos: [byPath, byId] }, '/repo', remoteTarget, 'repo-runtime')?.repo
    ).toBe(byId)
  })

  it('falls back to the path on the host when the id is not that host\u2019s', () => {
    const remote = makeRepo('repo-runtime', '/repo', 'runtime:env-1')

    expect(
      getRuntimeRepoTarget({ repos: [remote] }, '/repo', remoteTarget, 'repo-local')?.repo
    ).toBe(remote)
  })

  it('refuses when no row belongs to the target host', () => {
    const local = makeRepo('repo-local', '/repo')

    expect(getRuntimeRepoTarget({ repos: [local] }, '/repo', remoteTarget, 'repo-local')).toBeNull()
  })

  it('runs here for a target that is not a paired server', () => {
    const local = makeRepo('repo-local', '/repo')

    expect(
      getRuntimeRepoTarget({ repos: [local] }, '/repo', { kind: 'local' }, 'repo-local')
    ).toBeNull()
  })
})
