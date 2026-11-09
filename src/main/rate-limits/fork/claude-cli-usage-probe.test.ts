import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeChildProcessEnv } from '../../claude/claude-child-process-environment'
import {
  probeClaudeUsage,
  readClaudeUsageFromCli,
  type ClaudeUsageProbeDeps,
  type ClaudeUsageProbeProcess
} from './claude-cli-usage-probe'

type ProbeRunner = ClaudeUsageProbeDeps['runUsageControl']

function deps(runUsageControl: ProbeRunner): ClaudeUsageProbeDeps {
  return {
    resolveCommand: () => '/opt/claude/bin/claude',
    resolveCwd: () => '/tmp/orca-rate-limit-pty',
    buildEnv: (patch: Record<string, string>) => buildClaudeChildProcessEnv({ ...patch }),
    runUsageControl
  }
}

function runner(run: (request: ClaudeUsageProbeProcess, timeoutMs: number) => Promise<unknown>) {
  return vi.fn(run)
}

const reading = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 31, resets_at: '2026-11-01T01:09:59.695700+00:00' },
    seven_day: { utilization: 44, resets_at: '2026-11-05T15:59:59.695723+00:00' }
  }
}

describe('probeClaudeUsage', () => {
  it('spawns the account CLI against the profile it must report on', async () => {
    const runUsageControl = runner(async () => reading)

    const outcome = await probeClaudeUsage(
      { envPatch: { CLAUDE_CONFIG_DIR: '/Users/x/Library/orca/claude-profiles/a/home' } },
      deps(runUsageControl)
    )

    expect(outcome).toEqual({ status: 'ok', response: reading })
    const [request, timeoutMs] = runUsageControl.mock.calls[0]
    expect(request.command).toBe('/opt/claude/bin/claude')
    expect(request.cwd).toBe('/tmp/orca-rate-limit-pty')
    expect(request.env.CLAUDE_CONFIG_DIR).toBe('/Users/x/Library/orca/claude-profiles/a/home')
    // Why: an inherited API key would make the CLI report API billing instead of the plan.
    expect(request.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(timeoutMs).toBeGreaterThan(0)
  })

  it('reports why an unusable CLI could not answer instead of throwing', async () => {
    const outcome = await probeClaudeUsage(
      {},
      deps(
        runner(async () => {
          throw new Error('get_usage is not supported')
        })
      )
    )

    expect(outcome).toEqual({ status: 'unavailable', reason: 'get_usage is not supported' })
  })

  it('treats an empty answer as unavailable', async () => {
    expect(await probeClaudeUsage({}, deps(runner(async () => null)))).toEqual({
      status: 'unavailable',
      reason: 'the CLI answered no usage payload'
    })
  })

  it('does not spawn anything once the cycle is aborted', async () => {
    const runUsageControl = runner(async () => reading)
    const controller = new AbortController()
    controller.abort()

    expect(await probeClaudeUsage({ signal: controller.signal }, deps(runUsageControl))).toEqual({
      status: 'aborted'
    })
    expect(runUsageControl).not.toHaveBeenCalled()
  })

  it('reports an abort that lands while the CLI is answering', async () => {
    const controller = new AbortController()
    const runUsageControl = runner(async () => {
      controller.abort()
      return reading
    })

    expect(await probeClaudeUsage({ signal: controller.signal }, deps(runUsageControl))).toEqual({
      status: 'aborted'
    })
  })
})

describe('readClaudeUsageFromCli', () => {
  it('returns the mapped plan reading', async () => {
    const usage = await readClaudeUsageFromCli({}, deps(runner(async () => reading)))

    expect(usage?.status).toBe('ok')
    expect(usage?.session?.usedPercent).toBe(31)
    expect(usage?.weekly?.usedPercent).toBe(44)
    expect(usage?.usageMetadata?.source).toBe('cli')
  })

  it('returns null rather than a placeholder when the probe cannot answer', async () => {
    expect(await readClaudeUsageFromCli({}, deps(runner(async () => null)))).toBeNull()
    expect(
      await readClaudeUsageFromCli(
        {},
        deps(runner(async () => ({ rate_limits_available: false, rate_limits: null })))
      )
    ).toBeNull()
  })
})

describe('the turn a CLI with no usable get_usage has to spend', () => {
  it('hands the child the login, because the probe isolates itself from settings', async () => {
    const runUsageControl = runner(async () => ({
      status: 'ok-rate-limit-info',
      rateLimitInfo: { unifiedWindows: { five_hour: { utilization: 0.5 } } }
    }))

    const outcome = await probeClaudeUsage(
      { envPatch: { CLAUDE_CONFIG_DIR: '/Users/x/.claude' }, oauthToken: 'sk-ant-oat01-token' },
      deps(runUsageControl)
    )

    expect(outcome).toEqual({
      status: 'ok-rate-limit-info',
      rateLimitInfo: { unifiedWindows: { five_hour: { utilization: 0.5 } } }
    })
    const [request] = runUsageControl.mock.calls[0]
    expect(request.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-token')
    expect(request.env.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude')
  })

  it('leaves the child without a token when the account has none', async () => {
    const runUsageControl = runner(async () => null)

    await probeClaudeUsage({}, deps(runUsageControl))

    expect(runUsageControl.mock.calls[0][0].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('maps a rate-limit event onto a reading the status bar can render', async () => {
    const reading = await readClaudeUsageFromCli(
      { oauthToken: 'sk-ant-oat01-token' },
      deps(
        runner(async () => ({
          status: 'ok-rate-limit-info',
          rateLimitInfo: {
            unifiedWindows: {
              five_hour: { utilization: 0.4, resetsAt: 1_794_232_800 },
              seven_day: { utilization: 0.12, resetsAt: 1_794_499_200 }
            }
          }
        }))
      )
    )

    expect(reading?.session?.usedPercent).toBeCloseTo(40)
    expect(reading?.weekly?.usedPercent).toBeCloseTo(12)
    expect(reading?.usageMetadata?.source).toBe('cli')
  })

  it('reports no reading when the event carries no plan window', async () => {
    expect(
      await readClaudeUsageFromCli(
        {},
        deps(runner(async () => ({ status: 'ok-rate-limit-info', rateLimitInfo: {} })))
      )
    ).toBeNull()
  })
})

describe('the probe session loop', () => {
  const rle = {
    type: 'rate_limit_event',
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: 0.3, resetsAt: 1_794_232_800 },
        seven_day: { utilization: 0.1, resetsAt: 1_794_499_200 }
      }
    }
  }

  /**
   * Stand in for the SDK: yield `messages`, then park.
   *
   * Why park rather than end: the real session never ends, because the probe's input waits forever.
   * A generator that finished would let `for await` exit on its own, so a missing `break` on `result`
   * would still pass — the test would guard nothing.
   */
  async function* parkedSession(messages: unknown[]): AsyncGenerator<unknown> {
    for (const message of messages) {
      yield message
    }
    await new Promise(() => {})
  }

  function withFakeSdk(messages: unknown[]) {
    vi.doMock('../../claude/claude-stream-json-connection', () => ({
      loadClaudeAgentSdk: async () => ({
        query: () => Object.assign(parkedSession(messages), { close: vi.fn() })
      })
    }))
    vi.doMock('../../claude/claude-agent-sdk-process-spawn', () => ({
      createClaudeCodeProcessSpawn: () => ({ spawn: vi.fn() })
    }))
  }

  afterEach(() => {
    vi.doUnmock('../../claude/claude-stream-json-connection')
    vi.doUnmock('../../claude/claude-agent-sdk-process-spawn')
    vi.resetModules()
  })

  it('reads the event when it arrives before the turn ends', async () => {
    vi.resetModules()
    withFakeSdk([{ type: 'assistant' }, rle, { type: 'result' }])
    const { readClaudeUsageFromCli: fresh } = await import('./claude-cli-usage-probe')

    expect((await fresh())?.session?.usedPercent).toBeCloseTo(30)
  })

  it('gives up as soon as the turn ends without an event, rather than waiting out the deadline', async () => {
    vi.resetModules()
    withFakeSdk([{ type: 'result' }])
    const { readClaudeUsageFromCli: fresh } = await import('./claude-cli-usage-probe')

    const startedAt = performance.now()
    expect(await fresh()).toBeNull()
    // Why: the deadline is 15 s and the session never ends, so only the `result` break gets here.
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})
