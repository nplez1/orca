import { describe, expect, it, vi } from 'vitest'
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
