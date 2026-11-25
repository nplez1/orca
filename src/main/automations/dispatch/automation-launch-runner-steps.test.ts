import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import type {
  AutomationDispatchResult,
  AutomationRun
} from '../../../shared/automations/history/automation-run'
import type {
  AutomationScriptStepsOutcome,
  AutomationStepResult
} from '../../../shared/automations/steps/automation-step-results'
import type { AutomationRepoRunTarget } from '../ownership/run-target-resolution'
import { runAutomationLaunch } from './automation-launch-runner'

const result = (outcome: AutomationStepResult['outcome']): AutomationStepResult => ({
  stepId: 'first',
  kind: 'script',
  script: 'scripts/check.sh',
  contentHash: 'hash',
  outcome,
  exitCode: outcome === 'succeeded' ? 0 : outcome === 'failed' ? 2 : null,
  output: '',
  outputTruncated: false,
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1
})

/** Drives the real launch sequencing; only the store write and the agent launcher are recorded. */
async function launch(steps: Automation['steps'], scripts: AutomationScriptStepsOutcome) {
  const writes: Omit<AutomationDispatchResult, 'runId'>[] = []
  const launches: { stepEnv?: Readonly<Record<string, string>> }[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch sequence reads only these fields.
  const run = { id: 'run', trigger: 'manual', status: 'dispatching' } as AutomationRun
  await runAutomationLaunch({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch sequence reads only these fields.
    automation: { id: 'a', workspaceId: 'w', steps, precheck: null } as unknown as Automation,
    run,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch sequence reads only these fields.
    target: { ok: true, cwd: '/repo' } as unknown as AutomationRepoRunTarget,
    transition: (write) => {
      writes.push(write)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch sequence reads only these fields.
      return { applied: true, run: Promise.resolve({ ...run, ...write } as AutomationRun) }
    },
    runPrecheck: async () => null,
    runScriptSteps: async () => scripts,
    dispatcher: async (request) => {
      launches.push({ stepEnv: request.stepEnv })
      return { workspaceId: 'w', terminalSessionId: 't', completion: new Promise(() => {}) }
    },
    markDispatchResult: async () => run,
    watchRun: () => {}
  })
  return { writes, launches }
}

const script = { kind: 'script', id: 'first', script: 'scripts/check.sh' } as const
const agent = { kind: 'agent', id: 'agent' } as const

describe('script steps in the launch sequence', () => {
  it('completes a script-only run on the last exit without launching an agent', async () => {
    const ok = result('succeeded')
    const { writes, launches } = await launch(
      [{ ...script, timeoutSeconds: 5, onFailure: 'stop' }],
      { results: [ok], stoppedBy: null, env: {} }
    )
    expect(launches).toEqual([])
    expect(writes).toEqual([expect.objectContaining({ status: 'completed', stepResults: [ok] })])
  })

  it('fails the run on a stopping step and never launches the agent', async () => {
    const cut = result('cut_off')
    const { writes, launches } = await launch(
      [{ ...script, timeoutSeconds: 5, onFailure: 'stop' }, agent],
      { results: [cut], stoppedBy: cut, env: {} }
    )
    expect(launches).toEqual([])
    expect(writes).toEqual([
      expect.objectContaining({
        status: 'dispatch_failed',
        stepResults: [cut],
        error: expect.stringContaining('timeout')
      })
    ])
  })

  it('hands the scripts’ environment to the agent step', async () => {
    const env = { ORCA_STEP_FIRST_EXIT: '0' }
    const { writes, launches } = await launch(
      [{ ...script, timeoutSeconds: 5, onFailure: 'stop' }, agent],
      { results: [result('succeeded')], stoppedBy: null, env }
    )
    expect(launches).toEqual([{ stepEnv: env }])
    expect(writes[0]).toMatchObject({ status: 'dispatching', stepResults: [expect.anything()] })
  })
})
