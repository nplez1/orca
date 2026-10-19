import { describe, expect, it } from 'vitest'
import { parseSessionSummaryFoldParams } from './session-summary-host-service'

describe('parseSessionSummaryFoldParams', () => {
  it('accepts the params a desktop resolves from its own agent settings', () => {
    expect(
      parseSessionSummaryFoldParams({
        agentId: 'claude',
        model: 'sonnet',
        thinkingLevel: 'high',
        agentArgs: '--foo'
      })
    ).toEqual({ agentId: 'claude', model: 'sonnet', thinkingLevel: 'high', agentArgs: '--foo' })
  })

  it('accepts a custom agent command', () => {
    expect(
      parseSessionSummaryFoldParams({
        agentId: 'custom',
        model: 'default',
        customAgentCommand: 'x'
      })
    ).toEqual({ agentId: 'custom', model: 'default', customAgentCommand: 'x' })
  })

  // Checked, not cast: an agent this build does not know must fail the fold rather than
  // reach a spawn on the host.
  it('rejects an agent id this build does not know', () => {
    expect(parseSessionSummaryFoldParams({ agentId: 'not-an-agent', model: 'x' })).toBeNull()
  })

  it('rejects a missing model and a non-object', () => {
    expect(parseSessionSummaryFoldParams({ agentId: 'claude' })).toBeNull()
    expect(parseSessionSummaryFoldParams(null)).toBeNull()
    expect(parseSessionSummaryFoldParams('claude')).toBeNull()
  })

  it('drops empty optional strings instead of passing them on', () => {
    expect(
      parseSessionSummaryFoldParams({ agentId: 'claude', model: 'sonnet', agentArgs: '' })
    ).toEqual({ agentId: 'claude', model: 'sonnet' })
  })
})
