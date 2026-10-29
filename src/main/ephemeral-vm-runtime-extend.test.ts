import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { Store } from './persistence'

const mocks = vi.hoisted(() => ({
  getRuntimeRecipeContext: vi.fn(),
  getSshConnectionManager: vi.fn(),
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  invalidateRuntimeEnvironmentTransport: vi.fn()
}))

vi.mock('./ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: mocks.getRuntimeRecipeContext
}))
vi.mock('./ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: mocks.invalidateRuntimeEnvironmentTransport
}))
vi.mock('./ephemeral-vm/runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: mocks.connectRuntimeOwnedSshTarget,
  disconnectRuntimeOwnedSshTarget: mocks.disconnectRuntimeOwnedSshTarget
}))
vi.mock('./ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: mocks.getSshConnectionManager,
  // Why null: no SSH target store is registered in this harness, which is what the registry
  // answers before any host has been added.
  getSshTargetRegistryStore: () => null
}))

import {
  extendEphemeralVmRuntimeLease,
  resolveRequestedEphemeralVmExtendDuration
} from './ephemeral-vm-runtime-extend'
import { resetEphemeralVmRuntimeLocks } from './ephemeral-vm-runtime-lock'

const INITIAL_RELEASE_AT = '2026-06-01T12:00:00.000Z'
/** INITIAL plus one hour, which is what the incrementing extend script reports. */
const SECOND_RELEASE_AT = '2026-06-01T13:00:00.000Z'
const THIRD_RELEASE_AT = '2026-06-01T14:00:00.000Z'
const RUNTIME_ID = 'runtime-1'

const SSH_CONNECTION = {
  type: 'ssh',
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
} as const

/** The same host as the provider re-addressed it during the extension. */
const MOVED_SSH_CONNECTION = {
  ...SSH_CONNECTION,
  target: { ...SSH_CONNECTION.target, host: 'host-2' }
}

/** The mocked resolver never reads the store, so only a Store-shaped value has to exist. */
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getRuntimeRecipeContext is mocked in this file, so no Store member is ever called.
const unusedStore = {} as Store

type ExtendBehaviour =
  | { kind: 'fixed'; releaseAt: string }
  | { kind: 'moved' }
  | { kind: 'increment' }
  | { kind: 'drop-lifetime' }
  | { kind: 'exit'; code: number }
  /** Hangs the way a provider CLI waiting on an authentication prompt does. */
  | { kind: 'hang' }
  /** Releases the host mid-hook, as a workspace delete during the extension would. */
  | { kind: 'released-during-hook'; storePath: string }

type ExtendScript = {
  command: string
  /** Appended once per invocation, so an unrun script leaves it absent. */
  markerPath: string
  /** `<prior releaseAt>|<requested lifetime>`, one line per invocation. */
  seenPath: string
}

type Fixture = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
}

const tempDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

/**
 * A real extend hook rather than a stub, because the immutability property under test is which
 * command actually runs — and the hook only proves that by what it writes.
 */
function writeExtendScript(
  repoPath: string,
  name: string,
  behaviour: ExtendBehaviour
): ExtendScript {
  const scriptPath = join(repoPath, `${name}.js`)
  const markerPath = join(repoPath, `${name}.ran`)
  const seenPath = join(repoPath, `${name}.seen`)
  const connection = JSON.stringify(SSH_CONNECTION)
  const movedConnection = JSON.stringify(MOVED_SSH_CONNECTION)
  const lines = [
    "const fs = require('node:fs')",
    "let input = ''",
    "process.stdin.on('data', (chunk) => { input += chunk })",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(markerPath)}, 'ran\\n')`,
    '  const payload = JSON.parse(input)',
    '  const previous = payload.recipeResult.userData.releaseAt',
    `  fs.appendFileSync(${JSON.stringify(seenPath)}, previous + '|' + payload.lifetime + '\\n')`
  ]
  if (behaviour.kind === 'fixed') {
    lines.push(
      `  console.log(JSON.stringify({ schemaVersion: 1, connection: ${connection}, userData: { releaseAt: ${JSON.stringify(behaviour.releaseAt)} } }))`
    )
  }
  if (behaviour.kind === 'moved') {
    lines.push(
      `  console.log(JSON.stringify({ schemaVersion: 1, connection: ${movedConnection}, userData: { releaseAt: ${JSON.stringify(SECOND_RELEASE_AT)} } }))`
    )
  }
  if (behaviour.kind === 'increment') {
    lines.push(
      '  const next = new Date(Date.parse(previous) + 3600000).toISOString()',
      `  console.log(JSON.stringify({ schemaVersion: 1, connection: ${connection}, userData: { releaseAt: next } }))`
    )
  }
  if (behaviour.kind === 'drop-lifetime') {
    lines.push(`  console.log(JSON.stringify({ schemaVersion: 1, connection: ${connection} }))`)
  }
  if (behaviour.kind === 'exit') {
    lines.push(`  process.exit(${behaviour.code})`)
  }
  if (behaviour.kind === 'hang') {
    // Never answers: stdin is consumed, so only the deadline can end this run.
    lines.push('  setTimeout(() => undefined, 30_000)')
  }
  if (behaviour.kind === 'released-during-hook') {
    lines.push(
      `  const storePath = ${JSON.stringify(behaviour.storePath)}`,
      "  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))",
      "  store.runtimes = store.runtimes.map((entry) => entry.id === 'runtime-1' ? { ...entry, status: 'cleaned', cleanupStatus: 'succeeded' } : entry)",
      '  fs.writeFileSync(storePath, JSON.stringify(store))',
      `  console.log(JSON.stringify({ schemaVersion: 1, connection: ${connection}, userData: { releaseAt: ${JSON.stringify(SECOND_RELEASE_AT)} } }))`
    )
  }
  lines.push('})')
  writeFileSync(scriptPath, lines.join('\n'))
  return { command: nodeCommand(scriptPath), markerPath, seenPath }
}

function baseRuntime(): EphemeralVmRuntimeRecord {
  return {
    id: RUNTIME_ID,
    recipeId: 'cloud-sandbox',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace One',
    connectionMode: 'ssh',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: SSH_CONNECTION,
      userData: { releaseAt: INITIAL_RELEASE_AT, lifetimeSeconds: 3_600 }
    }
  }
}

/**
 * Mirrors the real `getRuntimeRecipeContext` by re-reading the store, which is what makes the lock's
 * re-read inside the critical section observable in the serialisation test.
 */
function makeFixture(): Fixture {
  const fixture: Fixture = {
    userDataPath: makeDir('orca-vm-extend-user-data-'),
    repoPath: makeDir('orca-vm-extend-repo-'),
    recipe: { id: 'cloud-sandbox', name: 'Cloud Sandbox', create: 'unused' }
  }
  mocks.getRuntimeRecipeContext.mockImplementation(
    (_store: unknown, userDataPath: string, runtimeId: string) => {
      const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
      }
      return {
        runtime,
        repo: { ok: true, repo: { path: fixture.repoPath, id: 'repo-1' } },
        recipe: fixture.recipe
      }
    }
  )
  return fixture
}

function seedRuntime(
  fixture: Fixture,
  overrides: Partial<EphemeralVmRuntimeRecord>
): EphemeralVmRuntimeRecord {
  return upsertEphemeralVmRuntime(fixture.userDataPath, { ...baseRuntime(), ...overrides })
}

function storedRuntime(fixture: Fixture): EphemeralVmRuntimeRecord {
  return listEphemeralVmRuntimes(fixture.userDataPath)[0]
}

function extend(fixture: Fixture, lifetime = '1h'): Promise<EphemeralVmRuntimeRecord> {
  return extendEphemeralVmRuntimeLease({
    userDataPath: fixture.userDataPath,
    store: unusedStore,
    runtimeId: RUNTIME_ID,
    lifetime
  })
}

/**
 * Why injected: the production deadline is two minutes, and a test that waited for it would be slower
 * than the suite's whole budget while proving exactly the same thing about the same code path.
 */
function extendWithDeadline(
  fixture: Fixture,
  hookTimeoutMs: number,
  lifetime = '1h'
): Promise<EphemeralVmRuntimeRecord> {
  return extendEphemeralVmRuntimeLease({
    userDataPath: fixture.userDataPath,
    store: unusedStore,
    runtimeId: RUNTIME_ID,
    lifetime,
    hookTimeoutMs
  })
}

function seenInvocations(script: ExtendScript): string[] {
  return readFileSync(script.seenPath, 'utf8').trim().split('\n')
}

beforeEach(() => {
  vi.resetAllMocks()
  resetEphemeralVmRuntimeLocks()
  mocks.getSshConnectionManager.mockReturnValue(null)
  mocks.disconnectRuntimeOwnedSshTarget.mockResolvedValue(undefined)
})

afterEach(() => {
  resetEphemeralVmRuntimeLocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveRequestedEphemeralVmExtendDuration', () => {
  it('canonicalizes a requested lifetime to the spelling the runtime declares', () => {
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['4h'] }, '4H')).toBe('4h')
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['1d'] }, '24h')).toBe('1d')
  })

  it('accepts a lifetime the runtime declares', () => {
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['1h', '4h'] }, '4h')).toBe(
      '4h'
    )
  })

  it('refuses a lifetime the runtime does not declare', () => {
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['1h'] }, '8h')).toBeNull()
  })

  it('refuses a value that is not a duration at all', () => {
    expect(
      resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['1h'] }, 'soon')
    ).toBeNull()
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: ['1h'] }, '30s')).toBeNull()
  })

  it('refuses when the runtime declares extend but no durations', () => {
    expect(resolveRequestedEphemeralVmExtendDuration({}, '1h')).toBeNull()
    expect(resolveRequestedEphemeralVmExtendDuration({ extendDurations: [] }, '1h')).toBeNull()
  })
})

describe('extending an ephemeral VM lease', () => {
  it('persists the provider result and moves the release deadline', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'runtime-extend', {
      kind: 'fixed',
      releaseAt: SECOND_RELEASE_AT
    })
    const seeded = seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h', '4h']
    })

    // The requested spelling is Orca's own UI spelling, not the runtime's canonical one.
    const updated = await extend(fixture, '4H')

    expect(existsSync(script.markerPath)).toBe(true)
    expect(seenInvocations(script)).toEqual([`${INITIAL_RELEASE_AT}|4h`])
    expect(updated.recipeResult).toMatchObject({ userData: { releaseAt: SECOND_RELEASE_AT } })
    expect(updated.updatedAt).toBeGreaterThan(seeded.updatedAt)
    expect(storedRuntime(fixture).recipeResult).toMatchObject({
      userData: { releaseAt: SECOND_RELEASE_AT }
    })
  })

  it('runs the verb from the runtime snapshot, not the recipe passed in', async () => {
    const fixture = makeFixture()
    const snapshotVerb = writeExtendScript(fixture.repoPath, 'snapshot-verb', {
      kind: 'fixed',
      releaseAt: SECOND_RELEASE_AT
    })
    const liveRecipeVerb = writeExtendScript(fixture.repoPath, 'live-recipe-verb', {
      kind: 'fixed',
      releaseAt: THIRD_RELEASE_AT
    })
    seedRuntime(fixture, { extend: snapshotVerb.command, extendDurations: ['1h'] })
    fixture.recipe = { ...fixture.recipe, extend: liveRecipeVerb.command }

    const updated = await extend(fixture)

    // A later orca.yaml edit must not be able to redirect an extension at a different script.
    expect(existsSync(snapshotVerb.markerPath)).toBe(true)
    expect(existsSync(liveRecipeVerb.markerPath)).toBe(false)
    expect(updated.recipeResult).toMatchObject({ userData: { releaseAt: SECOND_RELEASE_AT } })
  })

  it('reattaches the host when the provider re-addressed it during the extension', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 're-addressing-extend', { kind: 'moved' })
    seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h'],
      sshTargetId: 'runtime-ssh-1'
    })
    mocks.connectRuntimeOwnedSshTarget.mockResolvedValue({
      targetId: 'runtime-ssh-2',
      environmentId: 'env-2'
    })

    const updated = await extend(fixture)

    // Why disconnect first: the target registry would otherwise keep serving the old machine under
    // the new lease, which is the one thing an extension must never do.
    expect(mocks.disconnectRuntimeOwnedSshTarget).toHaveBeenCalledWith('runtime-ssh-1')
    expect(mocks.connectRuntimeOwnedSshTarget).toHaveBeenCalledWith({
      runtimeId: RUNTIME_ID,
      connection: MOVED_SSH_CONNECTION
    })
    expect(updated).toMatchObject({
      connectionMode: 'ssh',
      sshTargetId: 'runtime-ssh-2',
      runtimeEnvironmentId: 'env-2',
      recipeResult: { userData: { releaseAt: SECOND_RELEASE_AT } }
    })
  })

  it('clears a reconnect verdict the host earned before the extension', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'stale-verdict-extend', {
      kind: 'fixed',
      releaseAt: SECOND_RELEASE_AT
    })
    seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h'],
      sshTargetId: 'runtime-ssh-1'
    })
    const disconnect = vi.fn().mockResolvedValue(undefined)
    mocks.getSshConnectionManager.mockReturnValue({
      getState: () => ({ status: 'reconnection-failed' }),
      disconnect
    })

    await extend(fixture)

    // Why: the ladder arms no further timer once it gives up, so this verdict persists — and read at
    // the NEW deadline it would look like evidence the host never came back.
    expect(disconnect).toHaveBeenCalledWith('runtime-ssh-1')
  })

  it('throws on a provider failure and leaves the record exactly as it was', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'failing-extend', {
      kind: 'exit',
      code: 7
    })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })
    const before = storedRuntime(fixture)

    await expect(extend(fixture)).rejects.toThrow('Extend exited with code 7.')

    expect(existsSync(script.markerPath)).toBe(true)
    expect(storedRuntime(fixture)).toEqual(before)
  })

  it('refuses a result that dropped the lifetime metadata rather than persisting it', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'lifetime-less-extend', {
      kind: 'drop-lifetime'
    })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })
    const before = storedRuntime(fixture)

    await expect(extend(fixture)).rejects.toThrow(/no lifetime metadata/)

    // Losing the deadline would leave a paid-for lease with nothing to count down or reclaim.
    expect(storedRuntime(fixture)).toEqual(before)
  })

  it('refuses an unreadable deadline rather than overwriting the one that survives', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'unreadable-extend', {
      kind: 'fixed',
      // RFC 3339 without an offset, so it does not name an instant.
      releaseAt: '2026-10-13T03:26:41'
    })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })
    const before = storedRuntime(fixture)

    await expect(extend(fixture)).rejects.toThrow(
      /userData.releaseAt must be an RFC 3339 timestamp/
    )

    // The earlier deadline is still the best information Orca holds, so it must not be replaced.
    expect(storedRuntime(fixture)).toEqual(before)
  })

  it('accepts a lifetime-less result for a host that never had a deadline', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'lifetime-free-extend', {
      kind: 'drop-lifetime'
    })
    seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h'],
      recipeResult: {
        schemaVersion: 1,
        connection: SSH_CONNECTION,
        userData: { provider: 'example' }
      }
    })

    const updated = await extend(fixture)

    // Nothing to lose: refusing here would only break recipes that predate the lifetime contract.
    expect(updated.recipeResult).toEqual({ schemaVersion: 1, connection: SSH_CONNECTION })
    expect(storedRuntime(fixture).recipeResult).toEqual({
      schemaVersion: 1,
      connection: SSH_CONNECTION
    })
  })

  it('fails when the runtime has no extend verb rather than doing nothing quietly', async () => {
    const fixture = makeFixture()
    seedRuntime(fixture, { extendDurations: ['1h'] })

    await expect(extend(fixture)).rejects.toThrow('does not declare extend')
  })

  it('refuses to extend a runtime that has already been reclaimed', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'reclaimed-extend', {
      kind: 'fixed',
      releaseAt: SECOND_RELEASE_AT
    })
    seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h'],
      reclaimedAt: Date.parse(INITIAL_RELEASE_AT)
    })
    const before = storedRuntime(fixture)

    await expect(extend(fixture)).rejects.toThrow('already been released')

    expect(existsSync(script.markerPath)).toBe(false)
    expect(storedRuntime(fixture)).toEqual(before)
  })

  it('refuses to extend a runtime whose destroy is already in flight', async () => {
    // Why: the extension would buy time on a machine being torn down, and the two would race the
    // same record.
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'teardown-extend', {
      kind: 'fixed',
      releaseAt: SECOND_RELEASE_AT
    })
    seedRuntime(fixture, {
      extend: script.command,
      extendDurations: ['1h'],
      status: 'cleanup_pending',
      cleanupStatus: 'running'
    })

    await expect(extend(fixture)).rejects.toThrow('already been released')
    expect(existsSync(script.markerPath)).toBe(false)
  })

  it('queues a concurrent extend behind the one in flight and reads its result', async () => {
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'increment-extend', { kind: 'increment' })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })

    const [first, second] = await Promise.all([extend(fixture), extend(fixture)])

    // The second invocation saw the first's persisted deadline, so it re-read rather than
    // overwriting from the stale record both calls started with.
    expect(seenInvocations(script)).toEqual([`${INITIAL_RELEASE_AT}|1h`, `${SECOND_RELEASE_AT}|1h`])
    expect(first.recipeResult).toMatchObject({ userData: { releaseAt: SECOND_RELEASE_AT } })
    expect(second.recipeResult).toMatchObject({ userData: { releaseAt: THIRD_RELEASE_AT } })
    expect(storedRuntime(fixture).recipeResult).toMatchObject({
      userData: { releaseAt: THIRD_RELEASE_AT }
    })
  })

  it('stops a hook that never answers instead of holding the runtime lock forever', async () => {
    // Why this case exists: the hook holds the per-runtime lock, and the reclaim sweep works through
    // runtimes one at a time — so a hung hook used to stop every later action on this host.
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'hanging-extend', { kind: 'hang' })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })
    const before = storedRuntime(fixture)

    await expect(extendWithDeadline(fixture, 250)).rejects.toThrow(
      'did not finish within 250 ms and was stopped'
    )

    expect(existsSync(script.markerPath)).toBe(true)
    // Nothing about the lease moved, and the provider may still have granted it, so the record keeps
    // the deadline Orca can prove rather than a guess.
    expect(storedRuntime(fixture)).toEqual(before)
  })

  it('drops the new deadline when the host was released while the hook ran', async () => {
    // Why this case exists: destroy deliberately does not take this lock, so a workspace delete during
    // the hook is expected — and the old code wrote `recipeResult` onto the resulting `cleaned` record,
    // which then showed as a failed cleanup for a host that had in fact finished.
    const fixture = makeFixture()
    const script = writeExtendScript(fixture.repoPath, 'released-mid-extend', {
      kind: 'released-during-hook',
      storePath: getEphemeralVmRuntimeStorePath(fixture.userDataPath)
    })
    seedRuntime(fixture, { extend: script.command, extendDurations: ['1h'] })

    await expect(extend(fixture)).rejects.toThrow('was released while its lease was being extended')

    expect(existsSync(script.markerPath)).toBe(true)
    const after = storedRuntime(fixture)
    expect(after).toMatchObject({ status: 'cleaned', cleanupStatus: 'succeeded' })
    // The deadline the hook reported must not land on a record that is no longer a live host.
    expect(after.recipeResult).toMatchObject({ userData: { releaseAt: INITIAL_RELEASE_AT } })
  })
})
