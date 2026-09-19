import { describe, expect, it } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import {
  isSshTargetListedInStatusBar,
  runtimeHostConnectionDetail
} from './remote-host-connection-status'

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
