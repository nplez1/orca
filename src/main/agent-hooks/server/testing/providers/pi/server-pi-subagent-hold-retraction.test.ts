import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AgentHookServer } from '../../../agent-hook-server'
import type { EnrichedAgentHookEventPayload } from '../../../server-types'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-pi-hold-retraction-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const CHILD = { id: 'run-1', agent_type: 'researcher', description: 'trace the writer' }
const SESSION = { session_id: 'pi-session-1', session_file: '/sessions/pi-session-1.jsonl' }

async function piHook(hookEventName: string, payload: Record<string, unknown> = {}): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, ...payload }),
    '/hook/pi'
  )
  expect(response.status).toBe(204)
}

/** What the renderer is actually sent: one row at a time, and removals only as a pane-clear. */
function watchListeners(): {
  cleared: unknown[]
  dropped: string[]
  published: EnrichedAgentHookEventPayload[]
  changes: () => number
} {
  const cleared: unknown[] = []
  const dropped: string[] = []
  const published: EnrichedAgentHookEventPayload[] = []
  let changes = 0
  server.setPaneStatusClearListener((clear) => cleared.push(clear))
  server.subscribeStatusDrop((paneKey) => dropped.push(paneKey))
  server.subscribeEnrichedStatus((row) => published.push(row))
  server.subscribeStatusChanges(() => {
    changes += 1
  })
  return { cleared, dropped, published, changes: () => changes }
}

const visibleRows = (): AgentStatusIpcPayload[] =>
  server.getStatusSnapshotForPane(PANE).filter((row) => row.providerSessionOnly !== true)

it('tells every listener when the last child drains and no lead verdict claims the pane', async () => {
  const listeners = watchListeners()
  await piHook('subagent_async_state', { subagent_runs: [CHILD] })
  expect(visibleRows()[0]).toMatchObject({ state: 'working' })
  expect(visibleRows()[0]?.subagents?.map((child) => child.id)).toEqual(['run-1'])
  expect(listeners.cleared).toEqual([])
  const changesBeforeDrain = listeners.changes()

  await piHook('subagent_async_state', { subagent_runs: [] })

  // Why each of these: the hold was deleted in the shared store, and the pane kept painting it
  // because nothing was sent — no drop, no clear and no status-change notification.
  expect(listeners.cleared).toEqual([{ paneKey: PANE }])
  expect(listeners.dropped).toEqual([])
  expect(listeners.changes()).toBeGreaterThan(changesBeforeDrain)
  expect(visibleRows()).toEqual([])
  expect(server.getStatusChangeSnapshot()).toEqual([])
  // Why no `done`: nothing on this post described the pane's own turn, so no verdict may be invented.
  expect(listeners.published.filter((row) => row.payload.state === 'done')).toEqual([])
})

it('keeps the pane resume identity without claiming live work', async () => {
  const listeners = watchListeners()
  await piHook('subagent_async_state', { subagent_runs: [CHILD], ...SESSION })
  expect(visibleRows()[0]?.providerSession?.id).toBe('pi-session-1')

  await piHook('subagent_async_state', { subagent_runs: [], ...SESSION })

  expect(listeners.cleared).toEqual([{ paneKey: PANE }])
  expect(visibleRows()).toEqual([])
  const retained = server.getStatusSnapshotForPane(PANE)
  expect(retained).toEqual([expect.objectContaining({ providerSessionOnly: true })])
  expect(retained[0]?.subagents).toBeUndefined()
  expect(retained[0]?.providerSession?.id).toBe('pi-session-1')
})

it('retracts once, however many empty live sets arrive', async () => {
  const listeners = watchListeners()
  await piHook('subagent_async_state', { subagent_runs: [CHILD] })

  await piHook('subagent_async_state', { subagent_runs: [] })
  const changesAfterFirstDrain = listeners.changes()
  await piHook('subagent_async_state', { subagent_runs: [] })

  expect(listeners.cleared).toEqual([{ paneKey: PANE }])
  expect(listeners.changes()).toBe(changesAfterFirstDrain)
})

it('keeps a held row whose session still has scheduled work armed', async () => {
  const listeners = watchListeners()
  await piHook('subagent_async_state', { subagent_runs: [CHILD] })

  await piHook('subagent_async_state', {
    subagent_runs: [],
    scheduled_work: { jobs: [{ id: 'loop-1', kind: 'live', next_in_ms: 60_000 }] }
  })

  // Why: the loop will re-enter this session, so the pane is still claimed and clearing it would
  // strand a row the extension is about to republish.
  expect(listeners.cleared).toEqual([])
  expect(visibleRows()[0]?.state).toBe('working')
})
