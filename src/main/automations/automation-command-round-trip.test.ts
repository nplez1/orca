import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationAction } from '../../shared/automations/automation-definition'
import type { Repo } from '../../shared/repository/repo-types'
import { RuntimeAutomationController } from '../runtime/integrations/automations/runtime-automation-controller'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const repo: Repo = { id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 }

const action: AutomationAction = {
  kind: 'command',
  script: { command: 'echo report', timeoutSeconds: 60, shell: 'plain', report: 'on-output' }
}

describe('a command automation through the runtime and the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-command-record-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function created() {
    const store = await createStore()
    store.addRepo(repo)
    const controller = new RuntimeAutomationController(store, {
      showRepo: async () => repo,
      showManagedWorktree: async () => {
        throw new Error('no worktree in this test')
      }
    })
    const automation = await controller.create({
      name: 'Nightly report',
      prompt: '',
      action,
      agentId: null,
      precheck: { command: 'true', timeoutSeconds: 60 },
      extraAgentArgs: '--model opus',
      repo: 'r1',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    const stored = () => controller.show(automation.id)
    return { controller, automation, stored }
  }

  it('stores the command with no agent, precheck or launch settings', async () => {
    const { stored } = await created()
    expect(stored()).toMatchObject({ action, agentId: null, precheck: null, launchSetup: {} })
    expect(stored()).not.toHaveProperty('extraAgentArgs')
  })

  it('stays a command through an unrelated update', async () => {
    const { controller, automation, stored } = await created()
    await controller.update(automation.id, { enabled: false })
    expect(stored()).toMatchObject({ enabled: false, action, agentId: null })
  })

  it.each<[string, AutomationAction | null]>([
    ['an agent action', { kind: 'agent' }],
    ['null', null]
  ])('gives the automation an agent when the action is cleared with %s', async (_name, clear) => {
    const { controller, automation, stored } = await created()
    await controller.update(automation.id, { action: clear, agentId: 'claude', prompt: 'Report' })
    expect(stored()).toMatchObject({ agentId: 'claude' })
    expect(stored()).not.toHaveProperty('action')
  })

  it('refuses an agent for a command whose action is not cleared', async () => {
    const { controller, automation, stored } = await created()
    await expect(controller.update(automation.id, { agentId: 'claude' })).rejects.toThrow(
      'clear --script to give it an agent'
    )
    expect(stored()).toMatchObject({ action, agentId: null })
  })
})
