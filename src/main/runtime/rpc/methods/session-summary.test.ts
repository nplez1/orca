import { describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'

const mocks = vi.hoisted(() => {
  const state = {
    open: vi.fn(),
    folded: 0
  }
  return state
})

// The host service reaches user data and the hook server, neither of which exists in this
// test: only the params that arrive at `open` matter here.
vi.mock('../../../session-summary/session-summary-host-service', () => ({
  sessionSummaryHostService: () => ({
    open: mocks.open,
    peek: async () => snapshot({}),
    close: async () => {}
  }),
  parseSessionSummaryFoldParams: (value: unknown) =>
    value && typeof value === 'object' ? { agentId: 'claude', model: 'sonnet' } : null
}))

const { RpcDispatcher } = await import('../dispatcher')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const { SESSION_SUMMARY_RPC_METHODS } = await import('./session-summary')

function snapshot(_ignored: Record<string, unknown>): SessionSummarySnapshot {
  return {
    paneKey: 'tab-1:leaf-1',
    status: 'folding',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: true, completedChunks: 0, totalChunks: 0 }
  }
}

function dispatcher(): InstanceType<typeof RpcDispatcher> {
  return new RpcDispatcher({
    runtime: new OrcaRuntimeService(),
    methods: SESSION_SUMMARY_RPC_METHODS
  })
}

function openRequest(params: Record<string, unknown>) {
  return {
    id: 'summary-1',
    authToken: 'test',
    method: 'sessionSummary.openOnHost',
    params
  }
}

const foldParams = { agentId: 'claude', model: 'sonnet' }

describe('session summary host RPC', () => {
  // Why this is a wire test and not a handler test: the params schema is a plain `z.object`,
  // which silently strips a field it does not declare, so a forgotten `session` would look
  // exactly like a client that never sent one.
  it('forwards the viewer session identity the client sent', async () => {
    mocks.open.mockResolvedValue(snapshot({}))
    const session = {
      agentType: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath: '/home/user/.pi/agent/sessions/--srv-code--/pi-session-1.jsonl'
      }
    }

    await dispatcher().dispatch(openRequest({ paneKey: 'tab-1:leaf-1', foldParams, session }))

    expect(mocks.open).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      foldParams: { agentId: 'claude', model: 'sonnet' },
      session
    })
  })

  it('drops an identity it cannot read rather than passing it on', async () => {
    mocks.open.mockResolvedValue(snapshot({}))

    await dispatcher().dispatch(
      openRequest({
        paneKey: 'tab-1:leaf-1',
        foldParams,
        session: { agentType: 'pi', providerSession: { key: 'not-a-key', id: 'x' } }
      })
    )

    expect(mocks.open).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      foldParams: { agentId: 'claude', model: 'sonnet' },
      session: { agentType: 'pi' }
    })
  })

  // An older client sends nothing, and the host then reads its own row.
  it('accepts an open with no identity at all', async () => {
    mocks.open.mockResolvedValue(snapshot({}))

    await dispatcher().dispatch(openRequest({ paneKey: 'tab-1:leaf-1', foldParams }))

    expect(mocks.open).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      foldParams: { agentId: 'claude', model: 'sonnet' }
    })
  })
})
