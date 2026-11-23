import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PhotonApi } from './photon-api'
import { PhotonProvisioner, photonCreateKey } from './photon-provisioning'
import { PhotonStore } from './photon-store'
import { PhotonTeardown } from './photon-teardown'
import { startFakePhotonServer, type FakePhotonServer } from './photon-fake-server.test-fixture'

let server: FakePhotonServer
let userDataPath: string
const account = { kind: 'account' as const, key: 'pho_ask_account' }

beforeAll(async () => {
  server = await startFakePhotonServer()
})
afterAll(async () => {
  await server.close()
})
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-provision-'))
  server.state.projects.clear()
  server.state.idempotency.clear()
  server.state.keys.clear()
  server.state.assignments.clear()
  server.state.deleted.length = 0
  server.state.closureReadsRemaining = 0
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const provisioner = (store: PhotonStore): PhotonProvisioner =>
  new PhotonProvisioner({ api: new PhotonApi({ baseUrl: server.baseUrl }), store, log: () => {} })

describe('provisioning', () => {
  it('creates the project, mints the bot’s key and gives it a number in one pass', async () => {
    const store = new PhotonStore(userDataPath)
    const outcome = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.createdProject).toBe(true)
    expect(outcome.record).toMatchObject({
      botId: 'b1',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      completedThrough: 'assignment'
    })
    expect(outcome.record.phoneNumber).toBeTruthy()
    expect(store.projectKey('b1')?.secret).toBeTruthy()
    expect(server.state.projects.size).toBe(1)
  })

  it('finds the existing project on a re-run instead of creating a second one', async () => {
    const store = new PhotonStore(userDataPath)
    const first = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    const second = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(second.record.projectId).toBe(first.record.projectId)
    expect(second.createdProject).toBe(false)
    expect(server.state.projects.size).toBe(1)
    // The same number, because the assignment is asked for before it is created.
    expect(second.record.phoneNumber).toBe(first.record.phoneNumber)
    expect(server.state.assignments.size).toBe(1)
  })

  it('resumes after the project was created but the key mint failed', async () => {
    const store = new PhotonStore(userDataPath)
    server.state.failNextKeyMint = 500

    await expect(
      provisioner(store).provision({
        botId: 'b1',
        botName: 'Scout',
        handle: '+15551230000',
        account: { organizationId: 'org_1', credential: account }
      })
    ).rejects.toThrow()

    // The project id was persisted before the failure, so the retry does not make a second project.
    expect(store.bot('b1')?.completedThrough).toBe('project')
    const resumed = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(server.state.projects.size).toBe(1)
    expect(resumed.record.completedThrough).toBe('assignment')
    expect(store.projectKey('b1')?.secret).toBeTruthy()
  })

  it('resumes after the key was minted but the number was refused', async () => {
    const store = new PhotonStore(userDataPath)
    server.state.failNextAssignment = 403

    await expect(
      provisioner(store).provision({
        botId: 'b1',
        botName: 'Scout',
        handle: '+15551230000',
        account: { organizationId: 'org_1', credential: account }
      })
    ).rejects.toThrow()

    expect(store.bot('b1')?.completedThrough).toBe('key')
    expect(store.projectKey('b1')?.secret).toBeTruthy()

    const resumed = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    // The key it already had is kept, so the retry does not mint a second one.
    expect(server.state.keys.size).toBe(1)
    expect(resumed.record.phoneNumber).toBeTruthy()
  })

  it('reuses one derived create key, so a crash mid-create cannot make a second project', async () => {
    expect(photonCreateKey('b1')).toBe(photonCreateKey('b1'))
    expect(photonCreateKey('b1')).not.toBe(photonCreateKey('b2'))
  })
})

describe('the reconciler', () => {
  it('repairs a record whose assignment never got persisted', async () => {
    const store = new PhotonStore(userDataPath)
    const provisioned = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    // Simulate a crash between the assignment succeeding upstream and the record being written.
    store.putBot({ ...provisioned.record, assignments: [], completedThrough: 'key' })

    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.repaired).toBe(true)
    expect(outcome.record?.completedThrough).toBe('assignment')
    expect(outcome.record?.assignments).toHaveLength(1)
    // Repair, not rollback: the project upstream is still the same one.
    expect(server.state.projects.size).toBe(1)
  })

  it('repairs a stored slug that upstream disagrees with, without touching the project', async () => {
    const store = new PhotonStore(userDataPath)
    const provisioned = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    store.putBot({ ...provisioned.record, slug: 'orca-bot-stale' })

    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.repaired).toBe(true)
    expect(outcome.record?.slug).toBe('orca-bot-scout')
    expect(outcome.notes.join(' ')).toMatch(/slug repaired/)
  })

  it('says so instead of pretending when the project is gone upstream', async () => {
    const store = new PhotonStore(userDataPath)
    store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_gone',
      slug: 'orca-bot-gone',
      organizationId: 'org_1'
    })
    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.repaired).toBe(false)
    expect(outcome.notes.join(' ')).toMatch(/gone upstream/)
  })
})

describe('teardown', () => {
  const teardown = (store: PhotonStore): PhotonTeardown =>
    new PhotonTeardown({
      api: new PhotonApi({ baseUrl: server.baseUrl }),
      store,
      log: () => {},
      closureAttempts: 3,
      closureIntervalMs: 0,
      sleep: async () => {}
    })

  async function provisioned(): Promise<{ store: PhotonStore; projectId: string }> {
    const store = new PhotonStore(userDataPath)
    await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    const projectId = store.bot('b1')?.projectId
    if (!projectId) {
      throw new Error('provisioning wrote no project id')
    }
    return { store, projectId }
  }

  it('releases the number and revokes the key without deleting the project', async () => {
    const { store, projectId } = await provisioned()

    const outcome = await teardown(store).releaseBot({ botId: 'b1', account })

    expect(outcome.released).toEqual(['+15551230000'])
    expect(outcome.revokedKey).toBe(true)
    expect(outcome.projectKept).toBe(true)
    expect(server.state.deleted).toEqual([])
    expect(server.state.projects.has(projectId)).toBe(true)
    expect(server.state.assignments.size).toBe(0)
    // A tombstone rather than nothing: `deleteProject` throws "No Photon project is recorded" for a bot
    // whose record is gone, which made the separately confirmed cleanup unreachable.
    expect(store.bot('b1')).toMatchObject({ released: true, projectId, assignments: [] })
    expect(store.projectCredential('b1')).toBeNull()
  })

  it('does not revoke the key while a number is still unreleased, so a retry can authenticate', async () => {
    const { store } = await provisioned()
    // The release fails; the key must survive it, or the retry authenticates with a revoked key and
    // 401s forever.
    const broken = new PhotonTeardown({
      api: new PhotonApi({ baseUrl: server.baseUrl }),
      store,
      log: () => {},
      sleep: async () => {}
    })
    // The number release is what fails; a 500 on that DELETE is the shape of a provider hiccup.
    const assignmentId = store.bot('b1')?.assignments[0]?.assignmentId
    const projectId = store.bot('b1')?.projectId
    server.injectRaw(
      'DELETE',
      `/projects/${projectId}/platforms/imessage/assignments/${assignmentId}`,
      500,
      '{"error":"unavailable"}'
    )

    const outcome = await broken.releaseBot({ botId: 'b1', account })

    expect(outcome.problems.join(' ')).toMatch(/could not release/)
    expect(outcome.revokedKey).toBe(false)
    expect(server.state.keys.size).toBe(1)
    expect(store.bot('b1')?.released).not.toBe(true)
  })

  it('refuses a project deletion whose confirmation names a different slug', async () => {
    const { store } = await provisioned()
    await expect(
      teardown(store).deleteProject({ botId: 'b1', account, confirmSlug: 'orca-bot-other' })
    ).rejects.toThrow(/can never be reused/)
    expect(server.state.deleted).toEqual([])
  })

  it('deletes the project only when the slug is confirmed, and reports a still-closing state honestly', async () => {
    const { store, projectId } = await provisioned()
    server.state.closureReadsRemaining = 99

    const outcome = await teardown(store).deleteProject({
      botId: 'b1',
      account,
      confirmSlug: 'orca-bot-scout'
    })

    expect(server.state.deleted).toEqual([projectId])
    expect(outcome.state).toBe('closing')
    expect(outcome.terminal).toBe(false)
    expect(outcome.message).toMatch(/still closing/)
    // Not success, so the record is kept rather than forgotten.
    expect(store.bot('b1')).not.toBeNull()
  })

  it('polls the closure to a terminal state and only then forgets the record', async () => {
    const { store } = await provisioned()
    server.state.closureReadsRemaining = 1

    const outcome = await teardown(store).deleteProject({
      botId: 'b1',
      account,
      confirmSlug: 'orca-bot-scout'
    })

    expect(outcome.state).toBe('closed')
    expect(outcome.terminal).toBe(true)
    expect(outcome.message).toMatch(/never be reused/)
    expect(store.bot('b1')).toBeNull()
  })
})
