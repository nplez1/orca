import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  testState
} from './persistence-test-harness'

/**
 * What the store does with a plan and with the flat gate it replaces.
 *
 * Kept apart from the general automation persistence suite because these are the
 * two rules that decide whether a record is runnable at all: a plan is stored and
 * mirrored, and a plan and a precheck may not both be set.
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

describe('Store automation plans', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stores a script-only plan and clears the flat agent fields an older reader would use', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const automation = store.createAutomation({
      name: 'Daily latest build',
      steps: [
        {
          kind: 'script',
          command: 'git pull --ff-only && pnpm build',
          timeoutSeconds: 1800,
          onFailure: 'stop'
        }
      ],
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'w1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.steps).toHaveLength(1)
    expect(automation.prompt).toBe('')
    expect(automation.agentId).toBeUndefined()
    store.flush()
    const persisted = readDataFile() as { automations: Record<string, unknown>[] }
    expect(persisted.automations[0].agentId).toBeUndefined()
  })

  it('mirrors the agent step for an older reader while keeping the plan', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const automation = store.createAutomation({
      name: 'Build then report',
      steps: [
        { kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' },
        { kind: 'agent', prompt: 'Report the build.', agentId: 'claude' }
      ],
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'w1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.prompt).toBe('Report the build.')
    expect(automation.agentId).toBe('claude')

    // An older reader patching the flat fields edits the agent step inside the plan.
    const updated = store.updateAutomation(automation.id, {
      prompt: 'Report the build briefly.',
      agentId: 'codex'
    })
    expect(updated.prompt).toBe('Report the build briefly.')
    expect(updated.agentId).toBe('codex')
    expect(updated.steps).toEqual([
      { kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' },
      { kind: 'agent', prompt: 'Report the build briefly.', agentId: 'codex' }
    ])
  })

  it('leaves a stored plan alone when the patch never mentions it', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Daily latest build',
      steps: [{ kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }],
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'w1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const paused = store.updateAutomation(automation.id, { enabled: false })

    expect(paused.enabled).toBe(false)
    expect(paused.steps).toEqual(automation.steps)
    expect(paused.agentId).toBeUndefined()
  })

  it('refuses a plan the executor could not run', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    expect(() =>
      store.createAutomation({
        name: 'Two agents',
        steps: [
          { kind: 'agent', prompt: 'One.', agentId: 'claude' },
          { kind: 'agent', prompt: 'Two.', agentId: 'claude' }
        ],
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'w1',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        dtstart: new Date('2026-05-13T00:00:00Z').getTime()
      })
    ).toThrow('An automation can have only one agent step.')
  })

  it('refuses a precheck on a record that carries a plan', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    // The flat gate and a plan are two answers to "should this run at all".
    expect(() =>
      store.createAutomation({
        name: 'Gated plan',
        steps: [{ kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }],
        precheck: { command: 'gh pr list', timeoutSeconds: 30 },
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'w1',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        dtstart: new Date('2026-05-13T00:00:00Z').getTime()
      })
    ).toThrow('A precheck and steps cannot both be set')

    // The flat model keeps its gate: one agent step spelled flat is not a plan.
    const flat = store.createAutomation({
      name: 'Gated agent',
      prompt: 'Triage issues.',
      agentId: 'claude',
      precheck: { command: 'gh pr list', timeoutSeconds: 30 },
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'w1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    expect(flat.precheck).toEqual({ command: 'gh pr list', timeoutSeconds: 30 })
    expect(flat.steps).toBeUndefined()

    // Giving a gated record a plan is refused too, and says how to migrate.
    expect(() =>
      store.updateAutomation(flat.id, {
        steps: [{ kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }]
      })
    ).toThrow('express the gate as the first script step')
  })
})
