/**
 * A plan of script steps, through the real dispatch protocol.
 *
 * The point of the feature is that a deterministic automation costs nothing: no
 * agent CLI, no terminal, no completion watcher, and — because there is nothing to
 * launch — no window either. These tests drive the actual dispatch entry point with
 * the real process executor and a real shell command, so the claim is proven
 * end to end rather than asserted against a mock.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'
import type { AutomationStep } from '../../shared/automation-steps'
import type { Store } from '../persistence'
import type { AutomationRunTargetResult } from './run-target-resolution'
import {
  requestAutomationDispatch,
  type AutomationRendererChannel
} from './automation-dispatch-request'

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

function makeAutomation(steps: AutomationStep[], overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Daily latest build',
    steps,
    precheck: null,
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRun(automation: Automation, overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: automation.id,
    title: automation.name,
    scheduledFor: 1,
    status: 'pending',
    trigger: 'scheduled',
    workspaceId: automation.workspaceId,
    workspaceDisplayName: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 1,
    ...overrides
  }
}

const TARGET: Extract<AutomationRunTargetResult, { ok: true }> = {
  ok: true,
  cwd: process.cwd(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch protocol reads only the repo identity off the target, which is why it is stubbed.
  repo: {
    id: 'repo-1',
    path: process.cwd(),
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 1
  } as never
}

function dispatchFixture(input: {
  steps: AutomationStep[]
  headlessDispatcher?: boolean
  renderer?: boolean
}) {
  const automation = makeAutomation(input.steps)
  let current: AutomationRun = makeRun(automation)
  const written: AutomationDispatchResult[] = []
  const dispatcher = vi.fn(async () => ({
    workspaceId: 'workspace-1',
    terminalSessionId: null
  }))
  const sent: unknown[] = []
  const storeShape = {
    listAutomations: () => [automation],
    listAutomationRuns: () => [current],
    flushPendingOrThrowAsync: async () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch protocol reads exactly listAutomations, listAutomationRuns and a durable flush off the store, all of which are here.
  const store = storeShape as unknown as Store
  const rendererShape = {
    isDestroyed: () => false,
    send: (_c: string, r: unknown) => sent.push(r)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the protocol sends the dispatch request through this channel and reads nothing else off it.
  const rendererChannel = rendererShape as unknown as AutomationRendererChannel
  const renderer: AutomationRendererChannel | null = input.renderer ? rendererChannel : null
  return {
    automation,
    written,
    dispatcher,
    sent,
    getRun: () => current,
    context: {
      store,
      runs: {
        createRun: vi.fn(async () => current),
        updateRun: vi.fn(async (result: AutomationDispatchResult) => {
          written.push(result)
          current = { ...current, ...result, status: result.status }
          return current
        }),
        repeatSkip: vi.fn(async () => null),
        advanceNextRun: vi.fn(async () => automation)
      },
      isActive: () => true,
      getRenderer: () => renderer,
      headlessDispatcher: input.headlessDispatcher ? dispatcher : null,
      resolveTarget: (): AutomationRunTargetResult => TARGET,
      runPrecheck: vi.fn(async () => null),
      markDispatchResult: vi.fn(async () => current),
      watchRun: vi.fn()
    }
  }
}

describe('a plan of script steps', () => {
  it('completes with no agent, no dispatcher and no renderer, recording what ran', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand("console.log('built')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        }
      ]
    })
    const run = await requestAutomationDispatch(
      fixture.context,
      fixture.automation,
      fixture.getRun(),
      TARGET
    )
    expect(run.status).toBe('completed')
    const final = fixture.written.at(-1)!
    expect(final.status).toBe('completed')
    expect(final.error).toBeNull()
    expect(final.stepResults).toHaveLength(1)
    expect(final.stepResults![0]).toMatchObject({
      index: 0,
      kind: 'script',
      status: 'succeeded',
      exitCode: 0,
      label: nodeCommand("console.log('built')")
    })
    expect(final.outputSnapshot?.content).toContain('built')
    // Nothing was launched, and nothing was asked of a window.
    expect(fixture.dispatcher).not.toHaveBeenCalled()
    expect(fixture.sent).toEqual([])
  })

  it('runs every step and stops the run at the step that says stop', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand('process.exit(3)'),
          timeoutSeconds: 30,
          onFailure: 'stop'
        },
        {
          kind: 'script',
          command: nodeCommand("console.log('never')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        }
      ]
    })
    const run = await requestAutomationDispatch(
      fixture.context,
      fixture.automation,
      fixture.getRun(),
      TARGET
    )
    expect(run.status).toBe('dispatch_failed')
    const final = fixture.written.at(-1)!
    expect(final.stepResults).toHaveLength(1)
    expect(final.stepResults![0]).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(final.error).toContain('failed: Exited with code 3.')
  })

  it('carries on past a step that says continue', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand('process.exit(3)'),
          timeoutSeconds: 30,
          onFailure: 'continue'
        },
        {
          kind: 'script',
          command: nodeCommand("console.log('after')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        }
      ]
    })
    const run = await requestAutomationDispatch(
      fixture.context,
      fixture.automation,
      fixture.getRun(),
      TARGET
    )
    expect(run.status).toBe('completed')
    const final = fixture.written.at(-1)!
    expect(final.stepResults!.map((result) => result.status)).toEqual(['failed', 'succeeded'])
  })

  it('refuses a plan whose script steps would have no checkout, before running anything', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand("console.log('should not run')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        }
      ]
    })
    const automation = makeAutomation(fixture.automation.steps!, { workspaceMode: 'new_per_run' })
    const storeForRecord = { ...fixture.context.store, listAutomations: () => [automation] }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the protocol re-resolves the target from the store it was given, so the store has to list this record too.
    const context = { ...fixture.context, store: storeForRecord as unknown as Store }
    const run = await requestAutomationDispatch(context, automation, fixture.getRun(), TARGET)
    expect(run.status).toBe('skipped_unavailable')
    expect(fixture.written.at(-1)!.error).toContain('existing workspace')
    expect(fixture.written.at(-1)!.stepResults).toEqual([])
  })

  it('still hands a plan with an agent step to a dispatcher', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand("console.log('prepared')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        },
        { kind: 'agent', prompt: 'Finish the job.', agentId: 'claude' }
      ],
      headlessDispatcher: true
    })
    const run = await requestAutomationDispatch(
      fixture.context,
      fixture.automation,
      fixture.getRun(),
      TARGET
    )
    expect(run.status).toBe('dispatched')
    expect(fixture.dispatcher).toHaveBeenCalledOnce()
    // The scripts are persisted before the agent is launched, so a watcher that
    // finishes the run later cannot lose them: the store keeps a field the writer
    // omitted, which is what makes the dispatched write below safe.
    const withScripts = fixture.written.filter((result) => result.stepResults?.length === 1)
    expect(withScripts.length).toBeGreaterThan(0)
    expect(withScripts.at(-1)!.stepResults![0]).toMatchObject({ status: 'succeeded' })
  })

  it('refuses a plan that needs an agent when there is nowhere to launch it, without running its scripts', async () => {
    const fixture = dispatchFixture({
      steps: [
        {
          kind: 'script',
          command: nodeCommand("console.log('should not run')"),
          timeoutSeconds: 30,
          onFailure: 'stop'
        },
        { kind: 'agent', prompt: 'Finish the job.', agentId: 'claude' }
      ]
    })
    const run = await requestAutomationDispatch(
      fixture.context,
      fixture.automation,
      fixture.getRun(),
      TARGET
    )
    expect(run.status).toBe('skipped_unavailable')
    expect(fixture.written.at(-1)!.error).toContain('No Orca window was available')
    expect(fixture.written.at(-1)!.stepResults).toBeUndefined()
  })
})
