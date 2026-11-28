// The base triple of every release version names the upstream Orca a build is comparable to, so a
// silent regression here mislabels every release rather than one. Authored, not measured: the tag list
// is supplied, so the election can be pinned without a clone.
import { describe, expect, it } from 'vitest'
import {
  compareBaseVersions,
  parseUpstreamReleaseTag,
  pickUpstreamBase
} from '../../.github/scripts/fork-upstream-base-version.mjs'

const tag = (name, seconds) => ({ name, seconds })

describe('the upstream base version of a release', () => {
  it('accepts only a released X.Y.Z tag, not the fork line or a prerelease', () => {
    expect(parseUpstreamReleaseTag('v1.4.279')).toBe('1.4.279')
    expect(parseUpstreamReleaseTag('v1.4.214-np.66')).toBeNull()
    expect(parseUpstreamReleaseTag('v1.4.280-rc.1')).toBeNull()
    expect(parseUpstreamReleaseTag('archive/keep-me')).toBeNull()
  })

  it('takes the newest release at or before the sync base, never one cut after it', () => {
    const tags = [tag('v1.4.279', 900), tag('v1.4.280', 1100), tag('v1.4.214-np.66', 1000)]

    // The base is at 1000: 1.4.280 is upstream work this build does not carry.
    expect(pickUpstreamBase({ tags, baseSeconds: 1000, fallback: '1.4.214' }).version).toBe(
      '1.4.279'
    )
    // A base after both releases takes the newer one.
    expect(pickUpstreamBase({ tags, baseSeconds: 1200, fallback: '1.4.214' }).version).toBe(
      '1.4.280'
    )
  })

  it('compares by number, not by tag date, so a backdated tag cannot win', () => {
    const tags = [tag('v1.4.279', 1200), tag('v1.4.10', 1300)]
    expect(pickUpstreamBase({ tags, baseSeconds: 1400, fallback: '0.0.1' }).version).toBe('1.4.279')
  })

  it('falls back to package.json when the clone carries no eligible tag', () => {
    expect(pickUpstreamBase({ tags: [], baseSeconds: 1000, fallback: '1.4.214' })).toEqual({
      version: '1.4.214',
      name: null,
      seconds: null
    })
  })

  it('orders base versions the way the guard will', () => {
    expect(compareBaseVersions('1.4.279', '1.4.280')).toBe(-1)
    expect(compareBaseVersions('1.4.279', '1.5.0')).toBe(-1)
    expect(compareBaseVersions('1.4.279', '1.4.279')).toBe(0)
    expect(compareBaseVersions('2.0.0', '1.99.99')).toBe(1)
  })
})
