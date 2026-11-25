import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import {
  getAutomationScriptSteps,
  type AutomationScriptStep
} from '../../../shared/automations/steps/automation-steps'
import { runAutomationScriptSteps } from '../../../shared/automations/steps/automation-step-results'
import { createAutomationScriptStepExecutor } from '../../automations/dispatch/script-step-runner'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { approveAutomationScriptStep } from './automation-script-step-approval'

const step: AutomationScriptStep = {
  kind: 'script',
  id: 'check',
  script: 'check.sh',
  args: ['--quick'],
  timeoutSeconds: 10,
  onFailure: 'stop'
}

describe('script step approval', () => {
  it('is not a runtime RPC method, so agents, bots and paired clients cannot reach it', () => {
    const names = ALL_RPC_METHODS.map((method) => method.name)
    expect(names.length).toBeGreaterThan(100)
    expect(names.filter((name) => /approv/i.test(name) && /script|step/i.test(name))).toEqual([])
  })

  it('is called only from the desktop IPC handler and the store that serves it', async () => {
    const callers: string[] = []
    for (const entry of await readdir(join(process.cwd(), 'src'), { recursive: true })) {
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
        continue
      }
      const source = await readFile(join(process.cwd(), 'src', entry), 'utf8')
      if (/approveAutomationScriptStep|approveScriptStep/.test(source)) {
        callers.push(entry.split(sep).join('/'))
      }
    }
    expect(callers.sort()).toEqual([
      'main/ipc/automations.ts',
      'main/persistence/loading-store/automation-state/automation-persistence.ts',
      'main/persistence/scheduling-automations/automation-script-step-approval.ts',
      'preload/api/automations/automation-api.ts',
      'preload/api/automations/automations-bridge.ts',
      'renderer/src/components/automations/authoring/automation-script-step-review.ts'
    ])
  })
})

describe.skipIf(process.platform === 'win32')('review → approve → pin', () => {
  let cwd: string
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-step-approval-'))
    await writeFile(join(cwd, 'check.sh'), '#!/bin/sh\necho "checked $1"\n')
    await chmod(join(cwd, 'check.sh'), 0o755)
  })
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const runSteps = (automation: Pick<Automation, 'steps'>) =>
    runAutomationScriptSteps(
      getAutomationScriptSteps(automation),
      createAutomationScriptStepExecutor({ type: 'local', cwd, repo: { path: cwd, kind: 'git' } })
    )

  it('pins exactly the content the refused run recorded, which then runs', async () => {
    const refused = await runSteps({ steps: [step] })
    expect(refused.stoppedBy).toMatchObject({ outcome: 'unapproved' })
    const state = {
      automations: [{ id: 'a', steps: [step] }],
      automationRuns: [{ id: 'r', automationId: 'a', stepResults: refused.results }]
    }
    const operations = { state, flush: () => {} }
    approveAutomationScriptStep(operations, { automationId: 'a', runId: 'r', stepId: 'check' })

    const approved = await runSteps(state.automations[0]!)
    expect(approved.stoppedBy).toBeNull()
    expect(approved.results[0]).toMatchObject({ outcome: 'succeeded', output: 'checked --quick' })
  })

  it('refuses to approve when the step changed after the run it was shown from', async () => {
    const refused = await runSteps({ steps: [step] })
    const state = {
      automations: [{ id: 'a', steps: [{ ...step, args: ['--all'] }] }],
      automationRuns: [{ id: 'r', automationId: 'a', stepResults: refused.results }]
    }
    expect(() =>
      approveAutomationScriptStep(
        { state, flush: () => {} },
        { automationId: 'a', runId: 'r', stepId: 'check' }
      )
    ).toThrow(/changed since that run/)
  })
})
