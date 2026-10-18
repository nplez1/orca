import { describe, expect, it } from 'vitest'
import { isOrcaSkillLockSource } from './skill-freshness'

describe('isOrcaSkillLockSource', () => {
  it.each([
    'stablyai/orca',
    'nplez1/orca',
    'https://github.com/nplez1/orca',
    'https://github.com/StablyAI/orca.git',
    ' nplez1/orca/ '
  ])('accepts %s as an Orca-owned source', (source) => {
    // Why both owners: copies installed before this fork re-pointed the rail are locked to
    // upstream, and they are still this app's own skills — not a third party's same-named copy.
    expect(isOrcaSkillLockSource(source)).toBe(true)
  })

  it.each([null, '', 'vercel-labs/skills', 'acme/orca', 'nplez1/orca-fork'])(
    'rejects %s',
    (source) => {
      expect(isOrcaSkillLockSource(source)).toBe(false)
    }
  )
})
