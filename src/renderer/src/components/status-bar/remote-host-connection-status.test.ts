import { describe, expect, it } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import {
  isSshTargetListedInStatusBar,
  overallDotColor,
  overallStatus,
  runtimeHostBlockedCopy,
  runtimeHostConnectionDetail,
  runtimeHostStatusForOverall
} from './remote-host-connection-status'

describe('blocked runtime hosts', () => {
  it('counts a refused host as needing attention, never as connecting', () => {
    expect(runtimeHostStatusForOverall('disconnected', 'access-revoked')).toBe('blocked')
    expect(runtimeHostStatusForOverall('connected', 'incompatible')).toBe('blocked')
    expect(runtimeHostStatusForOverall('disconnected', undefined)).toBe('disconnected')
    expect(overallStatus(['blocked'])).toBe('attention')
    expect(overallStatus(['connected', 'blocked'])).toBe('attention')
    expect(overallStatus(['blocked', 'connecting'])).toBe('connecting')
    expect(overallDotColor('attention', 0)).toBe('bg-destructive')
  })

  it('words each refusal for what the user must do', () => {
    expect(runtimeHostBlockedCopy('access-revoked').label).toBe('Access revoked')
    expect(runtimeHostBlockedCopy('access-revoked').explanation).toMatch(/new pairing link/)
    expect(runtimeHostBlockedCopy('access-revoked', undefined, 'ssh').explanation).toMatch(/SSH/)
    // WSL and cloud VMs never re-pair over SSH, so they are not told they tried.
    const onConnect = runtimeHostBlockedCopy('access-revoked', undefined, 'connect').explanation
    expect(onConnect).toBe('Connect to try again.')
    const update = runtimeHostBlockedCopy('incompatible', {
      kind: 'blocked',
      reason: 'server-too-old',
      clientProtocolVersion: 5,
      serverProtocolVersion: 3,
      requiredServerProtocolVersion: 4
    })
    expect(update.label).toBe('Update required')
    expect(update.detail).toContain('Update Orca on the server')
    expect(runtimeHostBlockedCopy('incompatible').detail).toBeUndefined()
  })
})

describe('runtimeHostConnectionDetail', () => {
  it('suppresses stale failures while a handshake is in flight', () => {
    expect(runtimeHostConnectionDetail(diagnostics('awaiting_ready', 0, 'old failure'))).toBe(
      undefined
    )
    expect(
      runtimeHostConnectionDetail(diagnostics('awaiting_authenticated', 0, 'old failure'))
    ).toBe(undefined)
  })

  it('shows the upcoming reconnect attempt ahead of stale failures', () => {
    expect(runtimeHostConnectionDetail(diagnostics('reconnecting', 1, 'old failure'))).toBe(
      'Attempt 2'
    )
    expect(runtimeHostConnectionDetail(diagnostics('reconnecting', 2, 'old failure'))).toBe(
      'Attempt 3'
    )
  })

  it('keeps settled connection errors visible', () => {
    expect(runtimeHostConnectionDetail(diagnostics('closed', 0, 'socket closed'))).toBe(
      'socket closed'
    )
  })
})

function diagnostics(
  state: RemoteRuntimeSharedConnectionDiagnostics['state'],
  reconnectAttempt: number,
  lastError: string | null
): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state,
    reconnectAttempt,
    lastError,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    lastConnectedAt: null,
    lastClose: null
  }
}

describe('status-bar SSH host rows', () => {
  const hiddenTargetIds = new Set(['ssh-hidden'])

  it('lists every host that is not hidden', () => {
    expect(
      isSshTargetListedInStatusBar({
        targetId: 'ssh-visible',
        status: 'disconnected',
        hiddenTargetIds
      })
    ).toBe(true)
  })

  it('drops a hidden host with no live connection', () => {
    for (const status of ['disconnected', 'auth-failed', 'reconnection-failed', 'error'] as const) {
      expect(
        isSshTargetListedInStatusBar({ targetId: 'ssh-hidden', status, hiddenTargetIds })
      ).toBe(false)
    }
  })

  it('keeps a hidden host that is connected or still working on a connection', () => {
    // The exception the rule turns on: this popover is where a live connection is ended,
    // so hiding a host must not hide a session that is actually up. `connecting` and
    // `reconnecting` count as live too, or a hidden host blinks out on every reconnect.
    for (const status of ['connected', 'connecting', 'reconnecting', 'deploying-relay'] as const) {
      expect(
        isSshTargetListedInStatusBar({ targetId: 'ssh-hidden', status, hiddenTargetIds })
      ).toBe(true)
    }
  })
})
