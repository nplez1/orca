import { writeFile, appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dir, kill, pane, drain, prompt, stamp, now } from './claude-helper-kill.test-fixture'
import type { ClaudeLaunchedBackgroundTasks } from './claude-owed-task-notifications'

describe('Claude helper provider evidence', () => {
  it('preserves a newer complete oversized prompt through scheduled settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const p = await pane(true)
    const paneKey = p.row().paneKey
    const due = vi.spyOn(p.poller, 'poll')
    const tasks: ClaudeLaunchedBackgroundTasks = new Map()
    const resumed = (text: string) =>
      `${JSON.stringify({
        type: 'user',
        timestamp: stamp(20),
        message: { content: [{ type: 'text', text }] }
      })}\n`
    const preservation = () => ({
      child: p.row().payload.subagents?.find((child) => child.id === 'a123')?.state ?? null,
      waitOwner: p.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId ?? null,
      debt: { ...tasks.get('a123') },
      endings: p.publish.mock.calls.length
    })
    const expected = {
      child: 'working',
      waitOwner: 'a123',
      debt: { kind: 'agent', notificationOwedAt: now },
      endings: 0
    }
    try {
      const oversized = resumed('x'.repeat(262145))
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(256 * 1024)
      expect(Buffer.byteLength(prompt(-10) + oversized)).toBeLessThan(1024 * 1024)
      await appendFile(p.path, kill())
      await appendFile(p.child('a123'), oversized)
      await writeFile(p.child('acomplete'), resumed('Resume the work'))
      vi.setSystemTime(now + 25)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'acomplete' }))
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      p.replace(
        p.post({
          hook_event_name: 'PermissionRequest',
          agent_id: 'a123',
          tool_name: 'Bash',
          tool_use_id: 'oversized-approval',
          tool_input: { command: 'false' }
        })
      )
      tasks.set('a123', { kind: 'agent', notificationOwedAt: now })
      tasks.set('shell', { kind: 'shell', notificationOwedAt: now })
      p.state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, tasks)
      expect(preservation()).toEqual(expected)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(due).toHaveBeenCalled()
      await Promise.all(
        due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      const observed = {
        ...preservation(),
        control: p.row().payload.subagents?.find((child) => child.id === 'acomplete')?.state,
        shellDebt: tasks.get('shell'),
        timers: vi.getTimerCount()
      }
      process.stdout.write(`C9 complete oversized prompt ${JSON.stringify(observed)}\n`)
      expect(observed.control).toBe('working')
      expect(observed.shellDebt).toEqual({ kind: 'shell', notificationOwedAt: now })
      expect(preservation()).toEqual(expected)
      await appendFile(p.path, kill(30))
      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.all(
        due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId).toBeUndefined()
      expect(tasks.get('a123')?.settled).toBe(true)
      expect(tasks.get('shell')).toEqual({ kind: 'shell', notificationOwedAt: now })
      expect(p.row().payload.lastAssistantMessage).toBe('READY')
      // LOCAL(nplez1): a background shell is agent work here, so the held pane reads working without the badge.
      expect(p.row().payload).toMatchObject({ state: 'working', workingMode: undefined })
      expect(p.publish).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      p.poller.clearAll()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    }
  })

  it.each([false, true])(
    'ignores mixed server-result echoes after a kill; real prompt: %s',
    async (realPrompt) => {
      const p = await pane()
      try {
        await writeFile(p.child('a123'), prompt(1))
        await appendFile(p.path, kill(2))
        await appendFile(
          p.child('a123'),
          `${JSON.stringify({
            type: 'user',
            timestamp: stamp(3),
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'server context' },
                {
                  type: 'advisor_tool_result',
                  tool_use_id: 'server',
                  content: { type: 'advisor_redacted_result' }
                }
              ]
            }
          })}\n`
        )
        if (realPrompt) {
          await appendFile(p.child('a123'), prompt(4))
        }
        await drain(p)
        if (realPrompt) {
          expect(p.row().payload.subagents?.[0]?.state).toBe('working')
        } else {
          expect(p.row().payload.subagents ?? []).toEqual([])
        }
      } finally {
        p.poller.clearAll()
      }
    }
  )

  it('forgets kills on parent file replacement', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await writeFile(join(dir, 'replacement.jsonl'), kill())
      await rename(join(dir, 'replacement.jsonl'), p.path)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('does not apply an in-flight read after pane retirement or to its successor', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      const reading = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      p.poller.clear('test-tab:11111111-1111-4111-8111-111111111111')
      p.replace({
        ...p.row(),
        providerSession: { key: 'session_id', id: 'replacement', transcriptPath: p.path }
      })
      await reading
      expect(p.publish).not.toHaveBeenCalled()
    } finally {
      p.poller.clearAll()
    }
  })
})
