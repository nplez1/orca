import { describe, expect, it } from 'vitest'
import { clearStalePRRefreshError, type PRRefreshState } from './pr-refresh-state'

function errorState(updatedAt: number): PRRefreshState {
  return { status: 'error', reason: 'visible', updatedAt, message: 'boom', errorType: 'network' }
}

describe('clearStalePRRefreshError', () => {
  it('retracts the error a successful lookup predates', () => {
    const states = { branch: errorState(1_000) }

    const next = clearStalePRRefreshError(states, 'branch', 2_000)

    expect(next).toEqual({})
    expect(states.branch).toBeDefined()
  })

  it('retracts an error written in the same millisecond the request started', () => {
    expect(clearStalePRRefreshError({ branch: errorState(2_000) }, 'branch', 2_000)).toEqual({})
  })

  it('keeps an error newer than the request, which belongs to work still running', () => {
    expect(clearStalePRRefreshError({ branch: errorState(3_000) }, 'branch', 2_000)).toBeNull()
  })

  it('leaves in-flight and skipped states for their own writers', () => {
    const states: Record<string, PRRefreshState> = {
      pending: { status: 'in-flight', reason: 'visible', updatedAt: 1_000 },
      skipped: { status: 'skipped', reason: 'visible', updatedAt: 1_000 }
    }

    expect(clearStalePRRefreshError(states, 'pending', 2_000)).toBeNull()
    expect(clearStalePRRefreshError(states, 'skipped', 2_000)).toBeNull()
  })

  it('returns null for a key with no state', () => {
    expect(clearStalePRRefreshError({}, 'branch', 2_000)).toBeNull()
  })
})
