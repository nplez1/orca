// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionSummarySessionRef,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'
import { useSessionSummary } from './use-session-summary'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function snapshot(overrides: Partial<SessionSummarySnapshot> = {}): SessionSummarySnapshot {
  return {
    paneKey: PANE_KEY,
    status: 'folding',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: true, completedChunks: 0, totalChunks: 0 },
    ...overrides
  }
}

function installBridge(): { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const open = vi.fn(async () => snapshot())
  const close = vi.fn()
  vi.stubGlobal('api', {
    sessionSummary: { open, close, onUpdate: () => () => {} }
  })
  return { open, close }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useSessionSummary', () => {
  it('starts a fold against the pane and its workspace host', async () => {
    const { open } = installBridge()

    renderHook(() => useSessionSummary(PANE_KEY, true, 'runtime:env-1'))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))

    expect(open.mock.calls[0]?.[0]).toEqual({
      paneKey: PANE_KEY,
      executionHostId: 'runtime:env-1',
      // Re-entering the pane asks for the stored brief unless it is older than the window.
      revalidateWithinMs: 5 * 60_000
    })
  })

  // The folding side is not always the process holding the pane: a paired host runs only the
  // PTY, and its row for this pane can be absent. Sending the identity from the window that
  // has the pane is what lets that host brief a session it cannot identify itself.
  it('sends the pane session identity with the open', async () => {
    const { open } = installBridge()
    const session = {
      agentType: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-session-1',
        transcriptPath: '/home/user/.pi/agent/sessions/--srv-code--/pi-session-1.jsonl'
      }
    }

    renderHook(() => useSessionSummary(PANE_KEY, true, 'runtime:env-1', session))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))

    expect(open.mock.calls[0]?.[0]).toMatchObject({ session })
  })

  it('does not restart the fold when an equivalent identity is passed again', async () => {
    const { open } = installBridge()
    const session = {
      agentType: 'pi' as const,
      providerSession: { key: 'session_id' as const, id: 'pi-session-1' }
    }

    const { rerender } = renderHook(
      (props: { session: typeof session }) =>
        useSessionSummary(PANE_KEY, true, 'runtime:env-1', props.session),
      { initialProps: { session } }
    )
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))

    // A fresh object with the same values is what a store selector hands back on every
    // publish; treating that as a change would restart the fold continuously.
    await act(async () => {
      rerender({ session: { ...session, providerSession: { ...session.providerSession } } })
    })

    expect(open).toHaveBeenCalledTimes(1)
  })

  // The latch this session was stuck in: a pane opened before Pi reported its session
  // identity landed on "no readable transcript" and never asked again, because the old
  // effect depended only on paneKey/open/host. The identity arriving must re-open it.
  it('re-opens the fold when the pane session identity arrives', async () => {
    const { open } = installBridge()
    const session = {
      agentType: 'pi' as const,
      providerSession: { key: 'session_id' as const, id: 'pi-session-1' }
    }

    const initialProps: { session: SessionSummarySessionRef | null } = { session: null }
    const { rerender } = renderHook(
      (props: { session: SessionSummarySessionRef | null }) =>
        useSessionSummary(PANE_KEY, true, 'local', props.session),
      { initialProps }
    )
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0]?.[0]).not.toHaveProperty('session')

    await act(async () => {
      rerender({ session })
    })

    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(open.mock.calls[1]?.[0]).toMatchObject({ session })
  })

  it('accepts a snapshot only for the pane it belongs to', async () => {
    installBridge()

    const { result } = renderHook(() => useSessionSummary(PANE_KEY, true, 'runtime:env-1'))
    await waitFor(() => expect(result.current.snapshot?.paneKey).toBe(PANE_KEY))
  })
})
