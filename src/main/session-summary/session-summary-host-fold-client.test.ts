import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_SUMMARY_HOST_OUTDATED_MESSAGE,
  type SessionSummarySnapshot
} from '../../shared/session-summary-types'
import { createSessionSummaryHostFoldClient } from './session-summary-host-fold-client'

function snapshot(paneKey = 'tab-1:leaf-1'): SessionSummarySnapshot {
  return {
    paneKey,
    status: 'folding',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: true, completedChunks: 0, totalChunks: 2 }
  }
}

describe('createSessionSummaryHostFoldClient', () => {
  it('opens a fold on the host that owns the pane, carrying the chosen agent', async () => {
    const call = vi.fn(async () => snapshot())
    const client = createSessionSummaryHostFoldClient({ call })

    const result = await client.open({
      environmentId: 'env-1',
      paneKey: 'tab-1:leaf-1',
      foldParams: { agentId: 'claude', model: 'sonnet' }
    })

    expect(call).toHaveBeenCalledWith('env-1', 'sessionSummary.openOnHost', {
      paneKey: 'tab-1:leaf-1',
      foldParams: { agentId: 'claude', model: 'sonnet' },
      session: null
    })
    expect(result.paneKey).toBe('tab-1:leaf-1')
  })

  // The host may have no row for a pane whose layout lives on the client, and it was then
  // answering "no readable transcript" for a session it was running the whole time.
  it("carries the viewer's own session identity to the host", async () => {
    const call = vi.fn(async () => snapshot())
    const client = createSessionSummaryHostFoldClient({ call })
    const session = {
      agentType: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-session-1',
        transcriptPath: '/home/user/.pi/agent/sessions/--srv-code--/pi-session-1.jsonl'
      }
    }

    await client.open({
      environmentId: 'env-1',
      paneKey: 'tab-1:leaf-1',
      foldParams: null,
      session
    })

    expect(call).toHaveBeenCalledWith('env-1', 'sessionSummary.openOnHost', {
      paneKey: 'tab-1:leaf-1',
      foldParams: null,
      session
    })
  })

  it('peeks at the host fold without restarting it', async () => {
    const call = vi.fn(async () => snapshot())
    const client = createSessionSummaryHostFoldClient({ call })

    await client.peek({ environmentId: 'env-1', paneKey: 'tab-1:leaf-1' })

    expect(call).toHaveBeenCalledWith('env-1', 'sessionSummary.snapshotOnHost', {
      paneKey: 'tab-1:leaf-1'
    })
  })

  it('closes the host fold with the count the viewer actually saw', async () => {
    const call = vi.fn(async () => null)
    const client = createSessionSummaryHostFoldClient({ call })

    await client.close({ environmentId: 'env-1', paneKey: 'tab-1:leaf-1', seenTimelineCount: 7 })

    expect(call).toHaveBeenCalledWith('env-1', 'sessionSummary.closeOnHost', {
      paneKey: 'tab-1:leaf-1',
      seenTimelineCount: 7
    })
  })

  // A paired host updates on its own schedule, so "no such method" is a state with a
  // remedy ("update Orca there"), not a mystery failure.
  it('turns an unknown method into a named out-of-date host', async () => {
    const client = createSessionSummaryHostFoldClient({
      call: async () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 })
      }
    })

    await expect(
      client.open({ environmentId: 'env-1', paneKey: 'tab-1:leaf-1', foldParams: null })
    ).rejects.toMatchObject({ message: SESSION_SUMMARY_HOST_OUTDATED_MESSAGE })
  })

  it('passes a fold failure through untouched', async () => {
    const client = createSessionSummaryHostFoldClient({
      call: async () => {
        throw new Error('agent CLI produced no output')
      }
    })

    await expect(client.peek({ environmentId: 'env-1', paneKey: 'tab-1:leaf-1' })).rejects.toThrow(
      'agent CLI produced no output'
    )
  })

  it('rejects a response that is not a snapshot', async () => {
    const client = createSessionSummaryHostFoldClient({
      call: async () => ({ something: 'else' })
    })

    await expect(client.peek({ environmentId: 'env-1', paneKey: 'tab-1:leaf-1' })).rejects.toThrow(
      'invalid session summary snapshot'
    )
  })
})
