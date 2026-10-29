import { describe, expect, it } from 'vitest'
import {
  subagentAgentTypeFromPreamble,
  subagentAgentTypeFromSessionName
} from './session-scanner-subagent-declaration'

describe('subagentAgentTypeFromSessionName', () => {
  it('reads the agent type off the spawner-given name', () => {
    expect(subagentAgentTypeFromSessionName('Explore#06356862')).toBe('Explore')
    expect(subagentAgentTypeFromSessionName('general-purpose#05d9100d')).toBe('general-purpose')
  })

  it('accepts the spawner-id alphabet the workflow lane uses', () => {
    // `wf-agent-${index}` sliced to the spawner's 8 characters.
    expect(subagentAgentTypeFromSessionName('Explore#wf-agent')).toBe('Explore')
  })

  it('rejects names a person would give a session', () => {
    expect(subagentAgentTypeFromSessionName('Investigate usage tracking')).toBeNull()
    expect(subagentAgentTypeFromSessionName('Notes#1234')).toBeNull()
    expect(subagentAgentTypeFromSessionName('Notes#123456789')).toBeNull()
    // Ordinary names that are 8 characters of the same alphabet: `issue-42` is not hex, and
    // `20261028` is a calendar date rather than a UUID-derived id.
    expect(subagentAgentTypeFromSessionName('fix login#issue-42')).toBeNull()
    expect(subagentAgentTypeFromSessionName('release#20261028')).toBeNull()
    // Still indistinguishable from an id: a bare 8-digit suffix is the one shape the marker cannot
    // tell apart, and reading it as a sub-agent shows the row at top level rather than hiding it.
    expect(subagentAgentTypeFromSessionName('deploy#12345678')).toBe('deploy')
    expect(subagentAgentTypeFromSessionName('')).toBeNull()
    expect(subagentAgentTypeFromSessionName(undefined)).toBeNull()
    expect(subagentAgentTypeFromSessionName({ name: 'Explore#06356862' })).toBeNull()
  })
})

describe('subagentAgentTypeFromPreamble', () => {
  it('reads the active-agent tag the sub-agent prompt opens with', () => {
    expect(
      subagentAgentTypeFromPreamble('<active_agent name="Explore"/>\n\nYou are a sub-agent.')
    ).toBe('Explore')
    expect(subagentAgentTypeFromPreamble('<active_agent name="rpiv-advisor"/>')).toBe(
      'rpiv-advisor'
    )
  })

  it('ignores a preamble without the tag', () => {
    expect(subagentAgentTypeFromPreamble('You are a general-purpose coding agent.')).toBeNull()
    expect(subagentAgentTypeFromPreamble('')).toBeNull()
    expect(subagentAgentTypeFromPreamble(null)).toBeNull()
  })
})
