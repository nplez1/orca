import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

// Why: the home guard realpaths the stored path on the workspace's volume. A stalled volume must not
// hold the agent launch open, so the guard has to run inside the trust write's deadline (issue #157).
const mocks = vi.hoisted(() => ({
  realpath: vi.fn<(path: string) => Promise<string>>(),
  grant: vi.fn<(target: unknown, workspacePath: string) => Promise<string>>(async () => 'granted')
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  realpath: mocks.realpath
}))

vi.mock('./claude/claude-folder-trust-file', () => ({
  grantClaudeWorkspaceTrust: mocks.grant
}))

import {
  applyWorkspaceTrustOnThisHost,
  type WorkspaceTrustHost
} from './execution-host-workspace-trust'
import { SHORT_AGENT_TRUST_WRITE_DEADLINE_MS } from './agent-trust-write-deadline'

const HOST: WorkspaceTrustHost = {
  homes: ['/home/me'],
  agentHome: '/home/me',
  claudeConfig: () => ({ configFile: '/home/me/.claude.json', keyStyle: 'posix' }),
  codexConfigFiles: () => ['/home/me/.codex/config.toml'],
  deadlineMs: SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
}

describe('applyWorkspaceTrustOnThisHost home guard', () => {
  beforeEach(() => {
    mocks.grant.mockClear()
    mocks.realpath.mockReset()
  })

  it('gives up on a stalled realpath at the deadline and lets the agent ask', async () => {
    // Why setImmediate stays real: mocked fs I/O is driven by real event-loop turns, not fake timers.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.realpath.mockReturnValue(new Promise<string>(() => {}))
    try {
      let settled = false
      const trust = applyWorkspaceTrustOnThisHost('claude', '/workspace/app', () => HOST).then(
        () => {
          settled = true
        }
      )
      await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS - 1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(2)
      await trust
      expect(settled).toBe(true)
      expect(mocks.grant).not.toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('refuses the write when the guarded path resolves onto a home', async () => {
    // Why a link: only the realpath shows the stored path is the home, so this fails if the guard
    // ever compares spellings alone.
    mocks.realpath.mockImplementation(async (path: string) =>
      path === '/workspace/link' ? '/home/me' : path
    )
    await applyWorkspaceTrustOnThisHost('claude', '/workspace/link', () => HOST)
    expect(mocks.grant).not.toHaveBeenCalled()
  })

  it('writes when the guarded path resolves away from every home', async () => {
    mocks.realpath.mockImplementation(async (path: string) => path)
    await applyWorkspaceTrustOnThisHost('claude', '/workspace/app', () => HOST)
    expect(mocks.grant).toHaveBeenCalledTimes(1)
  })
})
