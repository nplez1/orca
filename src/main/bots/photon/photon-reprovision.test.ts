// What a re-run of provisioning must not erase, and what the reconciler must actually read back. Split
// from the saga's own suite because these are the tests that fail when a step "succeeds" over stale state.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PhotonApi } from './photon-api'
import { PhotonProvisioner } from './photon-provisioning'
import { PhotonStore } from './photon-store'
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
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-reprovision-'))
  server.state.projects.clear()
  server.state.idempotency.clear()
  server.state.keys.clear()
  server.state.assignments.clear()
  server.state.deleted.length = 0
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const provisioner = (store: PhotonStore): PhotonProvisioner =>
  new PhotonProvisioner({ api: new PhotonApi({ baseUrl: server.baseUrl }), store, log: () => {} })

describe('what a re-run must not erase', () => {
  it('keeps every member added since, instead of rewriting the list to the owner alone', async () => {
    const store = new PhotonStore(userDataPath)
    await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    const record = await store.bot('b1')
    if (!record) {
      throw new Error('no record')
    }
    // A member added through the run, then a re-run of provisioning: `assignments: [assignment]` used to
    // drop them, and from then on their texts were acked as unknown senders while still assigned.
    const member = await provisioner(store).assign({
      botId: 'b1',
      projectId: record.projectId,
      handle: '+15559990000',
      credential: { kind: 'project', key: 'pho_sk_1' }
    })
    await store.putBot({
      ...record,
      assignments: [
        ...record.assignments,
        {
          assignmentId: member.assignmentId,
          handle: member.handle,
          phoneNumber: member.phoneNumber
        }
      ]
    })

    const rerun = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(rerun.record.assignments.map((entry) => entry.handle).sort()).toEqual([
      '+15551230000',
      '+15559990000'
    ])
  })

  it('keeps a released member number released rather than replaying the assignment', async () => {
    const store = new PhotonStore(userDataPath)
    const first = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    const assignmentId = first.record.assignments[0]?.assignmentId ?? ''
    await new PhotonApi({ baseUrl: server.baseUrl }).releaseAssignment(
      { kind: 'project', key: 'pho_sk_1' },
      first.record.projectId,
      assignmentId
    )
    // The same idempotency key would replay the released assignment and show a number that is gone.
    const rerun = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    expect(rerun.record.assignments[0]?.assignmentId).not.toBe(assignmentId)
  })

  it('adopts the project already holding the slug instead of failing on 409 forever', async () => {
    const store = new PhotonStore(userDataPath)
    await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    // A second bot with the same name derives the same slug; before the lookup it was a permanent 409.
    const second = new PhotonStore(userDataPath)
    const outcome = await provisioner(second).provision({
      botId: 'b2',
      botName: 'Scout',
      handle: '+15559990000',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.record.slug).toBe('orca-bot-scout')
    expect(server.state.projects.size).toBe(1)
  })

  it('follows the handle the provider returned, so a typed phone number is still the owner', async () => {
    const store = new PhotonStore(userDataPath)
    await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '(555) 123-4567',
      account: { organizationId: 'org_1', credential: account }
    })

    // Comparing the typed form against the returned one made the owner a member.
    expect((await store.bot('b1'))?.ownerHandle).toBe('+15551234567')
  })
})

describe('the reconciler reading the provider back', () => {
  it('rebuilds the assignment list from upstream rather than from the one handle it was given', async () => {
    const store = new PhotonStore(userDataPath)
    const provisionedBot = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    // Upstream holds two numbers, this computer recorded none.
    await new PhotonApi({ baseUrl: server.baseUrl }).createAssignment({
      credential: { kind: 'project', key: 'pho_sk_1' },
      projectId: provisionedBot.record.projectId,
      handle: '+15559990000',
      idempotencyKey: 'extra-assignment'
    })
    await store.putBot({ ...provisionedBot.record, assignments: [] })

    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      account: { organizationId: 'org_1', credential: account }
    })

    expect(outcome.record?.assignments).toHaveLength(2)
    expect(outcome.notes.join(' ')).toMatch(/assignments repaired from upstream \(2 of them\)/)
  })

  it('re-mints a missing project key instead of only noting it', async () => {
    const store = new PhotonStore(userDataPath)
    const provisionedBot = await provisioner(store).provision({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000',
      account: { organizationId: 'org_1', credential: account }
    })
    await store.forgetProjectKey('b1')
    expect(await store.projectCredential('b1')).toBeNull()

    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      account: { organizationId: 'org_1', credential: account }
    })

    // The key cannot be read back, so a note alone left the bot unable to hear or answer.
    expect(await store.projectCredential('b1')).not.toBeNull()
    expect(outcome.notes.join(' ')).toMatch(/minted a replacement/)
    expect(outcome.record?.keyGeneration).toBe(provisionedBot.record.keyGeneration + 1)
  })

  it('does not claim a bot with a project and a key is complete when no number exists', async () => {
    const store = new PhotonStore(userDataPath)
    await store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_none',
      slug: 'orca-bot-none',
      organizationId: 'org_1'
    })
    server.state.projects.set('pho_prj_none', {
      id: 'pho_prj_none',
      slug: 'orca-bot-none',
      name: 'Scout',
      organizationId: 'org_1'
    })

    const outcome = await provisioner(store).reconcile({
      botId: 'b1',
      account: { organizationId: 'org_1', credential: account }
    })

    // No number means nobody can text it, so `completedThrough` stops at the key.
    expect(outcome.record?.completedThrough).toBe('key')
  })
})
