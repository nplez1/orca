import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  removeEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { EphemeralVmRuntimeReclaimed } from '../shared/ephemeral-vm-runtime-reclaim'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'

const mocks = vi.hoisted(() => ({
  getSshConnectionManager: vi.fn(),
  getRuntimeEnvironmentStatusSnapshots: vi.fn(),
  getRuntimeRecipeContext: vi.fn(),
  releaseEphemeralVmRuntimeEnvironments: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn()
}))

vi.mock('./ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: mocks.getSshConnectionManager
}))
vi.mock('./ipc/runtime-environments/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: mocks.getRuntimeEnvironmentStatusSnapshots
}))
vi.mock('./ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: mocks.getRuntimeRecipeContext
}))
vi.mock('./ephemeral-vm/runtime-environment-release', () => ({
  releaseEphemeralVmRuntimeEnvironments: mocks.releaseEphemeralVmRuntimeEnvironments
}))
vi.mock('./ephemeral-vm/runtime-ssh', () => ({
  removeRuntimeOwnedSshTarget: mocks.removeRuntimeOwnedSshTarget
}))

import {
  EphemeralVmRuntimeReclaimer,
  isEphemeralVmConnectionExhausted,
  startEphemeralVmRuntimeReclaim,
  stopEphemeralVmRuntimeReclaim
} from './ephemeral-vm-runtime-reclaim'
import {
  resetEphemeralVmRuntimeLocks,
  withEphemeralVmRuntimeLock
} from './ephemeral-vm-runtime-lock'

const NOW_MS = Date.parse('2026-06-01T12:00:00.000Z')
/** An hour before NOW_MS, so the provider deadline and the reclaim grace have both passed. */
const EXPIRED_RELEASE_AT = '2026-06-01T11:00:00.000Z'
/** An hour after NOW_MS: a lease extended out of band while the sweep is mid-pass. */
const EXTENDED_RELEASE_AT = '2026-06-01T13:00:00.000Z'

const SSH_CONNECTION = {
  type: 'ssh',
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
} as const

type Fixture = {
  userDataPath: string
  repoPath: string
  destroyScriptPath: string
  destroyMarkerPath: string
  destroyCommand: string
  sent: EphemeralVmRuntimeReclaimed[]
  getMainWindow: () => BrowserWindow | null
}

const tempDirs: string[] = []

/** Only the two members the sweep touches, so the stub is a complete stand-in for what it gets. */
function fakeWindow(sent: EphemeralVmRuntimeReclaimed[]): BrowserWindow {
  const stub = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, payload: EphemeralVmRuntimeReclaimed): void => {
        sent.push(payload)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep calls isDestroyed() and webContents.send() only, both present on the stub.
  return stub as never
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeFixture(destroyExitCode = 0): Fixture {
  const userDataPath = tempDir('orca-vm-reclaim-')
  const repoPath = tempDir('orca-vm-reclaim-repo-')
  const scriptPath = join(repoPath, 'destroy.js')
  const destroyMarkerPath = join(repoPath, 'destroy-ran.txt')
  writeFileSync(
    scriptPath,
    `require('fs').writeFileSync(${JSON.stringify(destroyMarkerPath)}, 'ran'); process.exit(${destroyExitCode})`
  )
  const sent: EphemeralVmRuntimeReclaimed[] = []
  return {
    userDataPath,
    repoPath,
    destroyScriptPath: scriptPath,
    destroyMarkerPath,
    destroyCommand: `"${process.execPath}" "${scriptPath}"`,
    sent,
    getMainWindow: () => fakeWindow(sent)
  }
}

function makeReclaimer(fixture: Fixture): EphemeralVmRuntimeReclaimer {
  return new EphemeralVmRuntimeReclaimer({
    userDataPath: fixture.userDataPath,

    getMainWindow: fixture.getMainWindow,
    now: () => NOW_MS
  })
}

/**
 * A trap rather than a fixture: nothing in the sweep resolves a recipe any more, so a reclaim that
 * went back to running `destroy` would find this one and leave the marker behind.
 */
function provideRecipe(fixture: Fixture, destroy: string | undefined = undefined): void {
  const recipe = {
    id: 'cloud-sandbox',
    name: 'Cloud Sandbox',
    create: 'unused',
    ...(destroy === undefined ? {} : { destroy })
  }
  mocks.getRuntimeRecipeContext.mockReturnValue({
    repo: { ok: true, repo: { path: fixture.repoPath, id: 'repo-1' } },
    recipe
  })
}

function runtime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace One',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: SSH_CONNECTION,
      userData: { releaseAt: EXPIRED_RELEASE_AT }
    },
    ...overrides
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSshConnectionManager.mockReturnValue(null)
  mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([])
  mocks.releaseEphemeralVmRuntimeEnvironments.mockResolvedValue(undefined)
  mocks.removeRuntimeOwnedSshTarget.mockResolvedValue(undefined)
  // Nothing in the sweep resolves a recipe now, so this throwing default only makes a regression loud.
  mocks.getRuntimeRecipeContext.mockImplementation(() => {
    throw new Error('Repo not found: repo-1')
  })
})

afterEach(() => {
  stopEphemeralVmRuntimeReclaim()
  resetEphemeralVmRuntimeLocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('reclaiming a lapsed ephemeral host', () => {
  it('reclaims a host whose provider deadline and SSH ladder have both run out', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())

    const reclaimed = await makeReclaimer(fixture).sweep()

    expect(reclaimed).toEqual(['runtime-1'])
    // Reclaiming releases Orca's own records; it never destroys the provider's machine.
    expect(existsSync(fixture.destroyMarkerPath)).toBe(false)
    const [record] = listEphemeralVmRuntimes(fixture.userDataPath)
    expect(record).toMatchObject({
      id: 'runtime-1',
      // The provider's TTL owns the resource, so `status` cannot claim the host was released.
      status: 'running',
      cleanupStatus: 'not_started',
      reclaimedAt: NOW_MS
    })
    // A cleared field is dropped by the store's JSON round trip, so assert it directly.
    expect(record.sshTargetId).toBeUndefined()
    expect(record.connectionMode).toBeUndefined()
    expect(mocks.releaseEphemeralVmRuntimeEnvironments).toHaveBeenCalledWith(
      fixture.userDataPath,
      expect.objectContaining({ id: 'runtime-1' }),
      expect.any(Function)
    )
    expect(mocks.removeRuntimeOwnedSshTarget).toHaveBeenCalledWith('runtime-ssh-1')
    expect(fixture.sent).toEqual([
      {
        runtimeId: 'runtime-1',
        repoId: 'repo-1',
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace One',
        releaseAt: EXPIRED_RELEASE_AT,
        // Captured before the registrations are released, so the renderer can match this host only.
        hostIds: [toSshExecutionHostId('runtime-ssh-1')]
      }
    ])
  })

  it('records the reclaimed host identities for a start-time reconcile', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])

    const [record] = listEphemeralVmRuntimes(fixture.userDataPath)
    // Why persisted at all: releasing the registrations clears `sshTargetId`, so an SSH-only host
    // would otherwise have no identity left for the renderer to match its workspace row on.
    expect(record.reclaimedHostIds).toEqual([toSshExecutionHostId('runtime-ssh-1')])
    expect(record.sshTargetId).toBeUndefined()
    expect(record.reclaimedHostIds).toEqual(fixture.sent[0].hostIds)
  })

  it('persists every identity a host was reachable as, not only the SSH one', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime({ runtimeEnvironmentId: 'env-1' }))

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])

    expect(listEphemeralVmRuntimes(fixture.userDataPath)[0].reclaimedHostIds).toEqual([
      toRuntimeExecutionHostId('env-1'),
      toSshExecutionHostId('runtime-ssh-1')
    ])
  })

  it('clears the connection it released, so a later workspace removal cannot re-enter cleanup', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime({ runtimeEnvironmentId: 'env-1' }))

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])

    // Why both: a record that still asserts an environment or a connection mode lets
    // `cleanupEphemeralVmRuntimesForDeleted` match it when the workspace row goes, and that path runs
    // the recipe's destroy — on a machine the user may still be using.
    const [record] = listEphemeralVmRuntimes(fixture.userDataPath)
    expect(record.runtimeEnvironmentId).toBeUndefined()
    expect(record.connectionMode).toBeUndefined()
    expect(record.sshTargetId).toBeUndefined()
  })

  it('never runs the recipe destroy, even though the recipe declares one that would run', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())

    const reclaimed = await makeReclaimer(fixture).sweep()

    // Why the script is checked first: the marker's absence proves nothing unless the script that
    // would write it was there and armed, so this assertion is what makes the next one mean anything.
    expect(readFileSync(fixture.destroyScriptPath, 'utf8')).toContain(fixture.destroyMarkerPath)
    expect(existsSync(fixture.destroyMarkerPath)).toBe(false)

    // The host is still released and announced; only the machine is left to the provider.
    expect(reclaimed).toEqual(['runtime-1'])
    expect(mocks.releaseEphemeralVmRuntimeEnvironments).toHaveBeenCalledTimes(1)
    expect(mocks.removeRuntimeOwnedSshTarget).toHaveBeenCalledWith('runtime-ssh-1')
    expect(fixture.sent).toEqual([expect.objectContaining({ runtimeId: 'runtime-1' })])
  })

  it('does not reclaim a runtime with no provider deadline', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({
        recipeResult: { schemaVersion: 1, connection: SSH_CONNECTION }
      })
    )

    expect(await makeReclaimer(fixture).sweep()).toEqual([])
    expect(listEphemeralVmRuntimes(fixture.userDataPath)[0]).toMatchObject({
      status: 'running',
      cleanupStatus: 'not_started',
      sshTargetId: 'runtime-ssh-1'
    })
    expect(existsSync(fixture.destroyMarkerPath)).toBe(false)
    expect(fixture.sent).toEqual([])
  })

  it('leaves a merely unreachable SSH host alone', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())
    const reclaimer = makeReclaimer(fixture)

    // The ladder is still retrying, the manager knows nothing about the target, and the manager
    // itself is absent: none of those is evidence the machine is gone.
    const cases = [
      { getState: () => ({ status: 'reconnecting' }) },
      { getState: () => ({ status: 'disconnected' }) },
      { getState: () => null },
      null
    ]
    for (const manager of cases) {
      mocks.getSshConnectionManager.mockReturnValue(manager)
      expect(await reclaimer.sweep()).toEqual([])
    }

    expect(listEphemeralVmRuntimes(fixture.userDataPath)[0]).toMatchObject({
      status: 'running',
      cleanupStatus: 'not_started',
      sshTargetId: 'runtime-ssh-1'
    })
    expect(existsSync(fixture.destroyMarkerPath)).toBe(false)
    expect(fixture.sent).toEqual([])
  })

  it('keeps sweeping when one runtime disappears before the sweep reaches it', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({ id: 'runtime-2', sshTargetId: 'runtime-ssh-2' })
    )
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({ id: 'runtime-3', sshTargetId: 'runtime-ssh-3' })
    )
    // Why here: removing it while the sweep works through runtime-1 is what leaves it in the pass's
    // first list but gone by the time the lock re-reads it.
    mocks.releaseEphemeralVmRuntimeEnvironments.mockImplementationOnce(async () => {
      removeEphemeralVmRuntime(fixture.userDataPath, 'runtime-2')
    })

    const reclaimed = await makeReclaimer(fixture).sweep()

    expect(reclaimed.sort()).toEqual(['runtime-1', 'runtime-3'])
    expect(mocks.removeRuntimeOwnedSshTarget).toHaveBeenCalledWith('runtime-ssh-1')
    expect(mocks.removeRuntimeOwnedSshTarget).toHaveBeenCalledWith('runtime-ssh-3')
    expect(mocks.removeRuntimeOwnedSshTarget).not.toHaveBeenCalledWith('runtime-ssh-2')
    expect(listEphemeralVmRuntimes(fixture.userDataPath).map((entry) => entry.id)).toEqual([
      'runtime-1',
      'runtime-3'
    ])
    expect(fixture.sent.map((payload) => payload.runtimeId).sort()).toEqual([
      'runtime-1',
      'runtime-3'
    ])
  })

  it('does nothing when the app has no main window to announce the reclaim to', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())

    const reclaimer = new EphemeralVmRuntimeReclaimer({
      userDataPath: fixture.userDataPath,

      getMainWindow: () => null,
      now: () => NOW_MS
    })
    expect(await reclaimer.sweep()).toEqual(['runtime-1'])
    // The reclaim is applied either way; only the announcement needs a renderer.
    expect(listEphemeralVmRuntimes(fixture.userDataPath)[0]).toMatchObject({
      status: 'running',
      reclaimedAt: NOW_MS
    })
  })

  it('reclaims an orca-server host once its environment refuses the pairing', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'blocked', transport: 'ready' }
    ])
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({
        connectionMode: 'orca-server',
        sshTargetId: undefined,
        runtimeEnvironmentId: 'env-1'
      })
    )

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])
    expect(mocks.releaseEphemeralVmRuntimeEnvironments).toHaveBeenCalledTimes(1)
    expect(mocks.removeRuntimeOwnedSshTarget).not.toHaveBeenCalled()
    expect(listEphemeralVmRuntimes(fixture.userDataPath)[0]).toMatchObject({
      status: 'running',
      reclaimedAt: NOW_MS
    })
    // The identity the renderer matches on is the environment, since this host has no SSH target.
    expect(fixture.sent).toEqual([
      expect.objectContaining({
        runtimeId: 'runtime-1',
        hostIds: [toRuntimeExecutionHostId('env-1')]
      })
    ])
  })

  it('reclaims an orca-server host whose probe simply keeps failing, past its deadline', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    // Why: shared control caps nothing, so an expired sandbox that never answers again produces no
    // stronger signal than a failed probe. Without this the common case would never be reclaimed.
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'unavailable', transport: 'disconnected' }
    ])
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({
        connectionMode: 'orca-server',
        sshTargetId: undefined,
        runtimeEnvironmentId: 'env-1'
      })
    )

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])
    expect(mocks.releaseEphemeralVmRuntimeEnvironments).toHaveBeenCalledTimes(1)
  })

  it('never reclaims an orca-server host whose probe has not settled yet', async () => {
    const fixture = makeFixture()
    provideRecipe(fixture, fixture.destroyCommand)
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'checking', transport: 'connecting' }
    ])
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({
        connectionMode: 'orca-server',
        sshTargetId: undefined,
        runtimeEnvironmentId: 'env-1'
      })
    )

    expect(await makeReclaimer(fixture).sweep()).toEqual([])
    expect(mocks.releaseEphemeralVmRuntimeEnvironments).not.toHaveBeenCalled()
  })

  it('reclaims a host once, however many sweeps run over it', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())
    const reclaimer = makeReclaimer(fixture)

    expect(await reclaimer.sweep()).toEqual(['runtime-1'])
    // `reclaimedAt` is the record's own memory of the reclaim, so a second pass has nothing to do.
    expect(await reclaimer.sweep()).toEqual([])

    expect(mocks.releaseEphemeralVmRuntimeEnvironments).toHaveBeenCalledTimes(1)
    expect(mocks.removeRuntimeOwnedSshTarget).toHaveBeenCalledTimes(1)
    expect(fixture.sent).toHaveLength(1)
  })

  it('decides from the record re-read inside the lock, not from the pass that queued it', async () => {
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({ id: 'runtime-2', sshTargetId: 'runtime-ssh-2' })
    )
    // Why this seam: runtime-2's lease is extended while the sweep is still working through runtime-1,
    // which is the race the re-read exists to close. A pass that decided from its first list, where
    // runtime-2 was already past its deadline, would release a host the user had just paid for.
    mocks.releaseEphemeralVmRuntimeEnvironments.mockImplementationOnce(async () => {
      updateEphemeralVmRuntimeStatus(fixture.userDataPath, 'runtime-2', {
        recipeResult: {
          schemaVersion: 1,
          connection: SSH_CONNECTION,
          userData: { releaseAt: EXTENDED_RELEASE_AT }
        }
      })
    })

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-1'])

    expect(
      listEphemeralVmRuntimes(fixture.userDataPath).find((entry) => entry.id === 'runtime-2')
    ).toMatchObject({ status: 'running', sshTargetId: 'runtime-ssh-2' })
    expect(mocks.removeRuntimeOwnedSshTarget).not.toHaveBeenCalledWith('runtime-ssh-2')
    expect(fixture.sent.map((payload) => payload.runtimeId)).toEqual(['runtime-1'])
  })

  it('skips a runtime another lifecycle operation holds, and still reclaims the rest', async () => {
    // Why: an extend hook holds this lock while it waits on the provider, so a sweep that queued behind
    // it stopped reclaiming every other runtime until the app restarted.
    const fixture = makeFixture()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    upsertEphemeralVmRuntime(fixture.userDataPath, runtime())
    upsertEphemeralVmRuntime(
      fixture.userDataPath,
      runtime({ id: 'runtime-2', sshTargetId: 'runtime-ssh-2' })
    )

    let finishHolder: () => void = () => undefined
    const holder = withEphemeralVmRuntimeLock(
      'runtime-1',
      () => new Promise<void>((resolve) => (finishHolder = resolve))
    )

    expect(await makeReclaimer(fixture).sweep()).toEqual(['runtime-2'])

    const skipped = listEphemeralVmRuntimes(fixture.userDataPath).find(
      (entry) => entry.id === 'runtime-1'
    )
    expect(skipped?.reclaimedAt).toBeUndefined()
    expect(skipped?.sshTargetId).toBe('runtime-ssh-1')

    finishHolder()
    await holder
  })
})

describe('isEphemeralVmConnectionExhausted', () => {
  it('reads only the SSH ladder giving up as exhausted', () => {
    const sshRuntime = runtime()
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnecting' })
    })
    expect(isEphemeralVmConnectionExhausted(sshRuntime)).toBe(false)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' })
    })
    expect(isEphemeralVmConnectionExhausted(sshRuntime)).toBe(true)
    mocks.getSshConnectionManager.mockReturnValue(null)
    expect(isEphemeralVmConnectionExhausted(sshRuntime)).toBe(false)
  })

  it('reads a failed runtime-environment probe as exhausted, but never an unsettled one', () => {
    const environmentRuntime = runtime({
      connectionMode: 'orca-server',
      sshTargetId: undefined,
      runtimeEnvironmentId: 'env-1'
    })
    // Why: shared control retries without a cap, so a failed probe alongside a passed provider
    // deadline is the strongest evidence this transport can produce.
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'unavailable', transport: 'disconnected' }
    ])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(true)
    // A probe that never settled is not a failure.
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'checking', transport: 'connecting' }
    ])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(false)
    // The host answered, so nothing is exhausted.
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'verified', transport: 'ready' }
    ])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(false)
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'blocked', transport: 'ready' }
    ])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(true)
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([
      { environmentId: 'env-1', verification: 'blocked', transport: 'disconnected', retired: true }
    ])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(true)
    // An environment with no status owner yet has produced no verdict at all.
    mocks.getRuntimeEnvironmentStatusSnapshots.mockReturnValue([])
    expect(isEphemeralVmConnectionExhausted(environmentRuntime)).toBe(false)
  })
})

describe('sweep scheduling', () => {
  it('arms one interval across repeated starts, and clears it on stop', () => {
    const fixture = makeFixture()
    vi.useFakeTimers()
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
      const context = {
        userDataPath: fixture.userDataPath,
        getMainWindow: fixture.getMainWindow,
        now: () => NOW_MS
      }

      startEphemeralVmRuntimeReclaim(context)
      startEphemeralVmRuntimeReclaim(context)

      // One armed interval across both registrations, and no teardown of the one that is armed.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)
      expect(clearIntervalSpy).not.toHaveBeenCalled()
      stopEphemeralVmRuntimeReclaim()
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
      stopEphemeralVmRuntimeReclaim()
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
