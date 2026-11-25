import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus
} from '../../shared/agent-status/contracts/agent-status-freshness'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status/contracts/agent-status-types'
import { normalizeHookPayload } from '../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { PANE_KEY } from '../../shared/agent-hook-listener/normalization/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/legacy-agent-status-test-seed'
import { createAgentStatusExtensionHarness } from './managed-extensions/agent-status/agent-status-extension-test-harness'

const REPOST_INTERVAL_MS = AGENT_STATUS_STALE_AFTER_MS / 3
const DAY_MS = 24 * 60 * 60 * 1000
const idle = { isIdle: () => true }

type Delivery = { at: number; hookEventName: string; accepted?: ParsedAgentStatusPayload }

// The two lanes that reach the roster's held turn on pi: OMP's lifecycle channel, and the fork's
// descendant bus handing it a pi-subagents child spawned inside the lead's turn.
const LANES = [
  {
    name: 'task:subagent:lifecycle',
    start: {
      channel: 'task:subagent:lifecycle',
      payload: { id: 'child-1', status: 'started', agent: 'worker' }
    },
    settle: { channel: 'task:subagent:lifecycle', payload: { id: 'child-1', status: 'completed' } }
  },
  {
    name: 'subagent:async-* through the descendant bus',
    start: {
      channel: 'subagent:async-started',
      payload: { id: 'child-1', mode: 'single', agent: 'worker', pid: 4000 }
    },
    settle: {
      channel: 'subagent:async-complete',
      payload: { id: 'child-1', runId: 'child-1', state: 'complete' }
    }
  }
] as const

afterEach(() => {
  vi.useRealTimers()
})

/** Feeds every post through the real listener entry, so the asserted pane is what a host shows. */
function createPane() {
  const state = createHookListenerState()
  const deliveries: Delivery[] = []
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' },
    fetchImpl: async (_url, init) => {
      const body: { payload: { hook_event_name: string } } = JSON.parse(String(init?.body))
      const event = normalizeHookPayload(state, 'pi', body, 'production')
      if (event) {
        seedLegacyAgentStatusForTests(state, event)
      }
      deliveries.push({
        at: Date.now(),
        hookEventName: body.payload.hook_event_name,
        accepted: event?.payload
      })
      return { ok: true }
    }
  })
  const hookNames = (): string[] => deliveries.map((delivery) => delivery.hookEventName)
  const reposts = (): Delivery[] =>
    deliveries.filter((delivery) => delivery.hookEventName === 'subagents_update')
  return { harness, deliveries, hookNames, reposts }
}

async function holdTurnOnChild(
  pane: ReturnType<typeof createPane>,
  lane: (typeof LANES)[number]
): Promise<void> {
  await pane.harness.callHook('before_agent_start', { prompt: 'delegate' }, idle)
  await pane.harness.callHook('agent_start', {}, idle)
  pane.harness.emitPiEvent(lane.start.channel, lane.start.payload)
  await vi.advanceTimersByTimeAsync(0)
  await pane.harness.callHook('agent_end', {}, idle)
  await pane.harness.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(0)
}

function longestSilence(deliveries: readonly Delivery[], until: number): number {
  const stamps = [...deliveries.map((delivery) => delivery.at), until]
  return Math.max(...stamps.slice(1).map((at, index) => at - stamps[index]))
}

describe.each(LANES)('a child-held pi turn on $name', (lane) => {
  it('stays fresh past the staleness window with its child row, until the child settles', async () => {
    vi.useFakeTimers()
    const pane = createPane()
    await holdTurnOnChild(pane, lane)
    expect(pane.hookNames()).not.toContain('agent_end')

    await vi.advanceTimersByTimeAsync(3 * AGENT_STATUS_STALE_AFTER_MS)
    expect(pane.reposts()).toHaveLength(9)
    expect(longestSilence(pane.deliveries, Date.now())).toBe(REPOST_INTERVAL_MS)
    const held = pane.deliveries.at(-1)?.accepted
    expect(held?.state).toBe('working')
    expect(held?.subagents?.map((child) => child.id)).toEqual(['child-1'])
    const lastHeld = pane.deliveries.at(-1)!
    expect(
      isFreshNonDoneAgentStatus({ state: 'working', updatedAt: lastHeld.at }, Date.now())
    ).toBe(true)

    pane.harness.emitPiEvent(lane.settle.channel, lane.settle.payload)
    await vi.advanceTimersByTimeAsync(0)
    expect(pane.hookNames().filter((name) => name === 'agent_end')).toHaveLength(1)
    expect(pane.deliveries.at(-1)?.accepted?.state).toBe('done')
    const settled = pane.deliveries.length
    await vi.advanceTimersByTimeAsync(2 * REPOST_INTERVAL_MS)
    expect(pane.deliveries).toHaveLength(settled)
  })

  it('keeps one repost timer across a Pi reload', async () => {
    vi.useFakeTimers()
    const pane = createPane()
    await holdTurnOnChild(pane, lane)

    await vi.advanceTimersByTimeAsync(REPOST_INTERVAL_MS / 2)
    await pane.harness.reloadPi()
    await pane.harness.callHook('session_start', { reason: 'reload' }, idle)
    await vi.advanceTimersByTimeAsync(REPOST_INTERVAL_MS)
    expect(pane.reposts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * REPOST_INTERVAL_MS)
    expect(pane.reposts()).toHaveLength(3)
    const afterReload = pane.reposts().at(-1)?.accepted
    expect(afterReload?.state).toBe('working')
    expect(afterReload?.subagents?.map((child) => child.id)).toEqual(['child-1'])
  })

  it('stops re-posting after a day without child lifecycle events, so host freshness decays the pane', async () => {
    vi.useFakeTimers()
    const pane = createPane()
    await holdTurnOnChild(pane, lane)

    await vi.advanceTimersByTimeAsync(DAY_MS)
    expect(pane.reposts()).toHaveLength(143)
    const capped = pane.deliveries.length
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS)
    expect(pane.deliveries).toHaveLength(capped)
    expect(pane.hookNames()).not.toContain('agent_end')

    const last = pane.deliveries.at(-1)
    expect(last?.accepted?.state).toBe('working')
    expect(isFreshNonDoneAgentStatus({ state: 'working', updatedAt: last!.at }, Date.now())).toBe(
      false
    )
  })
})

it('measures the one-day cap from the last child lifecycle event, not from the hold', async () => {
  vi.useFakeTimers()
  const pane = createPane()
  await holdTurnOnChild(pane, LANES[0])

  await vi.advanceTimersByTimeAsync(DAY_MS / 2)
  pane.harness.emitPiEvent('task:subagent:lifecycle', { id: 'child-1', status: 'running' })
  await vi.advanceTimersByTimeAsync(DAY_MS)
  expect(pane.reposts()).toHaveLength(215)
  const capped = pane.deliveries.length
  await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS)
  expect(pane.deliveries).toHaveLength(capped)
})
