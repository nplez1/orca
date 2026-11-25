import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AutomationStepsError,
  parseAutomationStepsForWrite,
  resolveAutomationSteps,
  type AutomationScriptStep
} from '../../../shared/automations/steps/automation-steps'
import {
  normalizeAutomationStepResults,
  runAutomationScriptSteps
} from '../../../shared/automations/steps/automation-step-results'
import { hashOrcaHookTrustContent } from '../../workspace-hooks/created-worktree-setup-trust'
import { createAutomationScriptStepExecutor } from './script-step-runner'

describe('automation steps: the legacy record is the one-step agent case', () => {
  it('reads a prompt-only record as one agent step and writes it back unchanged', () => {
    const legacy = { prompt: 'Triage the inbox', agentId: 'claude' as const }
    const resolved = resolveAutomationSteps(legacy)
    expect(resolved.ok && resolved.resolved).toEqual([
      { kind: 'agent', id: 'agent', prompt: 'Triage the inbox', agentId: 'claude' }
    ])
    // Storing nothing keeps a legacy record byte-identical, which an older host also reads.
    expect(parseAutomationStepsForWrite([{ kind: 'agent', id: 'agent' }])).toBeUndefined()
  })

  it('refuses an embedded shell body at write time with a typed error', () => {
    const write = () =>
      parseAutomationStepsForWrite([
        { kind: 'script', id: 'triage', script: 'npm ci\nnpm test', timeoutSeconds: 5 }
      ])
    expect(write).toThrow(AutomationStepsError)
    expect(write).toThrow(expect.objectContaining({ code: 'script_step_shell_body' }))
  })
})

describe.skipIf(process.platform === 'win32')('automation script steps on this host', () => {
  let cwd: string
  const scripts: Record<string, string> = {
    'ok.sh': '#!/bin/sh\necho "hello from ok"\n',
    'fail.sh': '#!/bin/sh\necho partial\nexit 3\n',
    'reads.sh': '#!/bin/sh\necho "saw=$ORCA_STEP_FIRST_STDOUT exit=$ORCA_STEP_FIRST_EXIT"\n',
    // Exits 0 on SIGTERM: a stopped step must still be cut off, never succeeded (#19334).
    'trap.sh': "#!/bin/sh\ntrap 'exit 0' TERM\nsleep 30 &\nwait\n"
  }
  const repo: { path: string; kind: 'git' } = { path: '', kind: 'git' }

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-script-steps-'))
    repo.path = cwd
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(join(cwd, name), content)
      await chmod(join(cwd, name), 0o755)
    }
  })
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const step = (
    id: string,
    script: string,
    overrides: Partial<AutomationScriptStep> = {}
  ): AutomationScriptStep => ({
    kind: 'script',
    id,
    script,
    timeoutSeconds: 10,
    onFailure: 'stop',
    approvedContentHash: scripts[script] ? hashOrcaHookTrustContent(scripts[script]) : undefined,
    ...overrides
  })
  const run = (steps: AutomationScriptStep[]) =>
    runAutomationScriptSteps(
      steps,
      createAutomationScriptStepExecutor({ type: 'local', cwd, repo })
    )

  it('hands the first step’s stdout and exit code to the next step', async () => {
    const outcome = await run([step('first', 'ok.sh'), step('second', 'reads.sh')])
    expect(outcome.stoppedBy).toBeNull()
    expect(outcome.results.map((result) => result.outcome)).toEqual(['succeeded', 'succeeded'])
    expect(outcome.results[1]!.output).toBe('saw=hello from ok\n exit=0')
    expect(outcome.results[0]!.contentHash).toBe(hashOrcaHookTrustContent(scripts['ok.sh']!))
    expect(outcome.env.ORCA_STEP_SECOND_EXIT).toBe('0')
  })

  it('stops on a real exit code by default, and continues only when told to', async () => {
    const stopped = await run([step('first', 'fail.sh'), step('second', 'ok.sh')])
    expect(stopped.results).toHaveLength(1)
    expect(stopped.stoppedBy).toMatchObject({ outcome: 'failed', exitCode: 3 })

    const continued = await run([
      step('first', 'fail.sh', { onFailure: 'continue' }),
      step('second', 'ok.sh')
    ])
    expect(continued.stoppedBy).toBeNull()
    expect(continued.results.map((result) => result.outcome)).toEqual(['failed', 'succeeded'])
  })

  it('records a timed-out step that exits 0 on SIGTERM as cut off', async () => {
    const outcome = await run([step('first', 'trap.sh', { timeoutSeconds: 1 })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'cut_off', exitCode: null })
  })

  it('refuses unapproved or changed content even under continue, and never runs it', async () => {
    const outcome = await run([
      step('first', 'ok.sh', { onFailure: 'continue', approvedContentHash: 'stale' }),
      step('second', 'ok.sh')
    ])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.stoppedBy).toMatchObject({
      outcome: 'unapproved',
      output: '',
      reviewContent: scripts['ok.sh']
    })
  })

  it('refuses a missing file as unverifiable rather than skipping it', async () => {
    const outcome = await run([step('first', 'missing.sh', { approvedContentHash: 'x' })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'unverifiable', contentHash: null })
  })

  it('persists results without the handoff stdout', async () => {
    const outcome = await run([step('first', 'ok.sh')])
    const [persisted] = normalizeAutomationStepResults(outcome.results)!
    expect(outcome.results[0]!.stdout).toBe('hello from ok\n')
    expect(persisted).not.toHaveProperty('stdout')
    expect(persisted).toMatchObject({ stepId: 'first', script: 'ok.sh', outcome: 'succeeded' })
  })
})
