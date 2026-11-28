// The release body leads with "…in this fork" groups, so a commit misread as the fork's would publish
// an upstream change under this fork's name. Authorship is the field a rebase preserves; subjects and
// the `local(...)` series cannot answer the question.
import { describe, expect, it } from 'vitest'
import {
  countStreams,
  forkClause,
  forkGroupTitle,
  isBookkeepingGroup,
  isForkCommit,
  splitEntriesByFork
} from '../../.github/scripts/fork-release-notes-fork-work.mjs'

const OWNER = { author: 'Nathan Plesnicher', email: 'nplez1@gmail.com' }
const FORK_BOT = {
  author: 'lab-agent-np[bot]',
  email: '356083733+lab-agent-np[bot]@users.noreply.github.com'
}
const UPSTREAM = { author: 'Neil', email: '4138956+nwparker@users.noreply.github.com' }

const classify = (subject) => ({ group: subject.startsWith('local(') ? 'local' : 'fix' })

describe('fork work in a release range', () => {
  it('reads authorship, so an upstream commit is never reported as the fork’s', () => {
    expect(isForkCommit(OWNER)).toBe(true)
    expect(isForkCommit(FORK_BOT)).toBe(true)
    expect(isForkCommit(UPSTREAM)).toBe(false)
  })

  it('leaves bookkeeping and merges out of both counts', () => {
    const commits = [
      { ...OWNER, subject: 'fix(hosts): one row per peer', parents: ['a'] },
      { ...FORK_BOT, subject: 'fix(pi): pane ownership', parents: ['b'] },
      { ...OWNER, subject: 'local(review): the manifest', parents: ['c'] },
      { ...UPSTREAM, subject: 'fix(jira): a date pill', parents: ['d'] },
      // A merge names no change of its own: the lead reports it, and the groups skip it.
      { ...UPSTREAM, subject: 'Merge upstream/main into main', parents: ['e', 'f'] }
    ]

    expect(countStreams(commits, classify)).toEqual({ forkCount: 2, inheritedCount: 1 })
    expect(isBookkeepingGroup('local')).toBe(true)
    expect(isBookkeepingGroup('chore')).toBe(true)
    expect(isBookkeepingGroup('fix')).toBe(false)
  })

  it('splits a group so the fork’s entries can be rendered apart from upstream’s', () => {
    const entries = [
      { text: 'ours', fork: true },
      { text: 'theirs', fork: false }
    ]

    expect(splitEntriesByFork(entries)).toEqual({
      fork: [{ text: 'ours', fork: true }],
      inherited: [{ text: 'theirs', fork: false }]
    })
    expect(forkGroupTitle('Fixes')).toBe('Fixes in this fork')
  })

  it('does not claim a fork change when the range holds none', () => {
    expect(forkClause(0, 3)).toBe('all of them inherited from upstream')
    expect(forkClause(2, 1)).toContain('this fork’s own')
    expect(forkClause(2, 1)).toContain('the other 1 inherited')
    expect(forkClause(0, 0)).toBe('no product change in this range')
  })
})
