import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AgentHookServer } from '../../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../../program-status/hook-precedence'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-pi-subagent-hold-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const CHILD = { id: 'run-1', agent_type: 'researcher', description: 'trace the writer' }

async function piHook(hookEventName: string, payload: Record<string, unknown> = {}): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, ...payload }),
    '/hook/pi'
  )
  expect(response.status).toBe(204)
}

/** pi's own TUI settles the moment the turn ends, children or not. */
function programDone(): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'pi' }
  })
}

const row = () => server.getStatusSnapshotForPane(PANE)[0]

it('keeps a pane working, with its child, past the hook-silence fallback while the child runs', async () => {
  await piHook('before_agent_start', { prompt: 'delegate the sweep' })
  await piHook('tool_execution_end', { subagent_runs: [CHILD] })
  await piHook('agent_end')
  expect(row()?.state).toBe('working')
  expect(row()?.subagents?.map((child) => child.id)).toEqual(['run-1'])

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // pi reports this done once; only the hook-silence recheck can offer it again.
  programDone()

  // Why: the held row states the lead's verdict, so hook precedence never lapses here. Without it the
  // terminal report takes the pane at the end of this window, and the row it publishes carries no
  // `subagents` — the pane reads done and the child's row disappears while the child still runs.
  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(row()?.state).toBe('working')
  expect(row()?.subagents?.map((child) => child.id)).toEqual(['run-1'])
})

it('still hands a hook-silent pane with no child to its terminal status', async () => {
  await piHook('before_agent_start', { prompt: 'run the build' })
  await piHook('agent_end', { subagent_runs: [] })

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // A turn held open by its own long tool call has no `mainAgent` verdict to state, so the ordinary
  // fallback must keep working — otherwise a hook-silent pane pins itself working for good.
  await piHook('before_agent_start', { prompt: 'run the build' })
  programDone()

  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(row()?.state).toBe('done')
})
