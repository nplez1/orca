import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getGitHubRepoLookupIndex } from './github-repo-lookup-index'

function makeRepo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: 'blue', addedAt: 1, kind: 'git' }
}

describe('getGitHubRepoLookupIndex', () => {
  it('retains the first duplicate after indexing later rows', () => {
    const first = makeRepo('duplicate', '/first')
    const second = makeRepo('duplicate', '/second')
    const later = makeRepo('later', '/later')
    const lookup = getGitHubRepoLookupIndex([first, second, later])

    expect(lookup.findById('duplicate')).toBe(first)
    expect(lookup.findById('later')).toBe(later)
    expect(lookup.findById('duplicate')).toBe(first)
  })

  it('matches Array.find ordering for combined ID and path lookups', () => {
    const pathMatch = makeRepo('other', '/target')
    const idMatch = makeRepo('target', '/other')
    const lookup = getGitHubRepoLookupIndex([pathMatch, idMatch])

    expect(lookup.findByIdOrPath('target', '/target')).toBe(pathMatch)
  })

  // Why: two machines can hold a checkout at the same path, and can publish the same repo id
  // twice, so a caller that knows the host must be able to name the row on that host alone.
  it('keeps host-scoped id and path lookups apart from another host\u2019s row', () => {
    const local = makeRepo('repo', '/same')
    const remote = { ...makeRepo('repo', '/same'), executionHostId: 'runtime:env-1' as const }
    const lookup = getGitHubRepoLookupIndex([local, remote])

    expect(lookup.findByPathOnHost('/same', 'runtime:env-1')).toBe(remote)
    expect(lookup.findByPathOnHost('/same', 'local')).toBe(local)
    expect(lookup.findByIdOnHost('repo', 'runtime:env-1')).toBe(remote)
    expect(lookup.findByIdOnHost('repo', 'local')).toBe(local)
    expect(lookup.findByIdOnHost('repo', 'ssh:other')).toBeUndefined()
    expect(lookup.findByPathOnHost('/other', 'runtime:env-1')).toBeUndefined()
  })

  it('scans each repo once across repeated misses', () => {
    let idReads = 0
    const repos = Array.from({ length: 32 }, (_, index) => {
      const repo = makeRepo(`repo-${index}`, `/repo-${index}`)
      return Object.defineProperty(repo, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          idReads += 1
          return `repo-${index}`
        }
      })
    })
    const lookup = getGitHubRepoLookupIndex(repos)

    expect(lookup.findById('missing-first')).toBeUndefined()
    expect(lookup.findById('missing-second')).toBeUndefined()
    expect(idReads).toBe(repos.length)
  })

  it('stops after a sparse first-row match', () => {
    let idReads = 0
    const repos = Array.from({ length: 32 }, (_, index) => {
      const repo = makeRepo(`repo-${index}`, `/repo-${index}`)
      return Object.defineProperty(repo, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          idReads += 1
          return `repo-${index}`
        }
      })
    })

    expect(getGitHubRepoLookupIndex(repos).findById('repo-0')).toBe(repos[0])
    expect(idReads).toBe(1)
  })
})
