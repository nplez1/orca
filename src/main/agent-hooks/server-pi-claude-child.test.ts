import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { piClaudeParentMarkerPath } from '../../shared/pi-claude-parent-marker'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

afterEach(() => vi.restoreAllMocks())

const PARENT_SESSION = {
  session_id: 'pi-parent-session',
  session_file: '/tmp/orca-pi-parent-session.jsonl'
}
const CHILD_CONVERSATION = 'claude-child-conversation'

describe('a claude CLI child of a pi subagent, through the hook server', () => {
  it('keeps the pi row and the parent turn, and records the parent link', async () => {
    const server = new AgentHookServer()
    const dir = mkdtempSync(join(tmpdir(), 'orca-pi-claude-child-'))
    const transcript = join(dir, `${CHILD_CONVERSATION}.jsonl`)
    server.setListener(vi.fn())
    await server.start({ env: 'production' })
    try {
      const post = async (source: string, payload: Record<string, unknown>) => {
        const response = await postHookEvent(
          server,
          buildBody(payload, { paneKey: PANE }),
          `/hook/${source}`
        )
        expect(response.status).toBe(204)
      }

      await post('pi', {
        hook_event_name: 'before_agent_start',
        prompt: 'delegate the review',
        ...PARENT_SESSION
      })
      await post('pi', {
        hook_event_name: 'tool_execution_start',
        ...PARENT_SESSION,
        subagent_runs: [
          {
            id: 'run-1',
            agent_type: 'general-purpose',
            description: 'review the diff',
            provider_session: CHILD_CONVERSATION
          }
        ]
      })
      const before = server.getStatusSnapshot()[0]
      expect(before?.agentType).toBe('pi')
      const turnBefore = before?.turnStartedAt
      expect(turnBefore).toBeTypeOf('number')

      await post('claude', {
        hook_event_name: 'SessionStart',
        session_id: CHILD_CONVERSATION,
        transcript_path: transcript,
        source: 'startup'
      })
      await post('claude', {
        hook_event_name: 'PreToolUse',
        session_id: CHILD_CONVERSATION,
        transcript_path: transcript,
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })

      const after = server.getStatusSnapshot()[0]
      // Exactly one row, still the pi session, and its own turn clock is untouched.
      expect(server.getStatusSnapshot()).toHaveLength(1)
      expect(after?.agentType).toBe('pi')
      expect(after?.prompt).toBe('delegate the review')
      expect(after?.providerSession?.id).toBe('pi-parent-session')
      expect(after?.turnStartedAt).toBe(turnBefore)
      expect(after?.subagents).toEqual([
        expect.objectContaining({
          id: 'run-1',
          agentType: 'general-purpose',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        })
      ])
      // The child's own transcript path is the marker's business, not the row's.
      expect(after).not.toHaveProperty('piClaudeChildParent')

      expect(existsSync(piClaudeParentMarkerPath(transcript))).toBe(true)
      expect(JSON.parse(readFileSync(piClaudeParentMarkerPath(transcript), 'utf8'))).toMatchObject({
        type: 'orca-pi-claude-subagent',
        parentSessionId: 'pi-parent-session',
        runId: 'run-1'
      })
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
