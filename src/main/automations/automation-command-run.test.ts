import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationScript } from '../../shared/automations/automation-definition'
import { AutomationService } from './automation-service'

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

describe('a command automation run', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-command-run-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  /** No launcher of any kind: a command needs none. */
  async function commandService(command: string, report: AutomationScript['report'] = 'on-output') {
    const store = await createStore()
    store.addRepo({
      id: 'r1',
      path: testState.dir,
      displayName: 'test',
      badgeColor: '#fff',
      addedAt: 1
    })
    const automation = store.createAutomation({
      name: 'Script',
      prompt: '',
      action: { kind: 'command', script: { command, timeoutSeconds: 60, shell: 'plain', report } },
      agentId: null,
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    const service = new AutomationService(store)
    const read = (runId: string) =>
      store.listAutomationRuns(automation.id).find((run) => run.id === runId)
    const settled = (runId: string, status: string) =>
      vi.waitFor(() => expect(read(runId)?.status).toBe(status), { timeout: 15_000 })
    return { service, automation, read, settled }
  }

  it('records the output and a zero exit as completed', async () => {
    const { service, automation, read, settled } = await commandService('echo report')
    const run = await service.runNow(automation.id)
    await settled(run.id, 'completed')
    expect(read(run.id)).toMatchObject({
      sessionKind: 'script',
      exitCode: 0,
      error: null,
      outputSnapshot: { content: 'report' },
      dispatchedAt: expect.any(Number)
    })
  })

  it('records a failed exit with its stderr, even for a silent command', async () => {
    const { service, automation, read, settled } = await commandService(
      'echo broken 1>&2 && exit 3',
      'silent'
    )
    const run = await service.runNow(automation.id)
    await settled(run.id, 'dispatch_failed')
    expect(read(run.id)).toMatchObject({
      exitCode: 3,
      error: 'Command exited with code 3.\nbroken',
      outputSnapshot: null,
      dispatchedAt: expect.any(Number)
    })
  })

  it('skips a second run while the first is running, and a stop leaves it unsettled', async () => {
    const { service, automation, read, settled } = await commandService(
      'node -e "setTimeout(() => {}, 60000)"'
    )
    const first = await service.runNow(automation.id)
    await settled(first.id, 'dispatching')
    const second = await service.runNow(automation.id)
    await settled(second.id, 'skipped_unavailable')
    expect(read(second.id)?.errorCode).toBe('overlap')

    service.stop()
    // The killed command closes after the stop; its outcome belongs to no live dispatch.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(read(first.id)?.status).toBe('dispatching')
  })
})
