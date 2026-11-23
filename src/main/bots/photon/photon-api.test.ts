import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PhotonApi, PhotonApiError } from './photon-api'
import {
  PHOTON_SLUG_MAX,
  PHOTON_VERSION,
  PhotonContractError,
  photonClosureIsTerminal,
  photonSlugForBot
} from './photon-contract'
import { startFakePhotonServer, type FakePhotonServer } from './photon-fake-server.test-fixture'

let server: FakePhotonServer
let api: PhotonApi
let keys = 0

const account = { kind: 'account' as const, key: 'pho_ask_account' }

beforeAll(async () => {
  server = await startFakePhotonServer()
  api = freshApi()
})
afterAll(async () => {
  await server.close()
})
afterEach(() => {
  server.state.requests.length = 0
})
const freshApi = (): PhotonApi =>
  new PhotonApi({
    baseUrl: server.baseUrl,
    // Deterministic keys make the replay assertions about the client, not about randomness.
    newIdempotencyKey: () => `idem-${(keys += 1)}`
  })

describe('the request contract', () => {
  it('pins Photon-Version on every call and sends the credential as a bearer token', async () => {
    const seen: { version?: string; auth?: string } = {}
    const watching = new PhotonApi({
      baseUrl: server.baseUrl,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init.headers)
        seen.version = headers.get('photon-version') ?? undefined
        seen.auth = headers.get('authorization') ?? undefined
        return fetch(input, init)
      }
    })
    await watching.getProject(account, 'pho_prj_missing')
    expect(seen.version).toBe(PHOTON_VERSION)
    expect(seen.auth).toBe(`Bearer ${account.key}`)
  })

  it('refuses a response shape it does not know instead of reading it as empty', async () => {
    server.injectRaw('GET', '/projects/pho_prj_odd', 200, JSON.stringify({ id: 7, nothing: true }))
    await expect(api.getProject(account, 'pho_prj_odd')).rejects.toBeInstanceOf(PhotonContractError)
  })

  it('refuses a body that is not JSON at all', async () => {
    server.injectRaw('GET', '/projects/pho_prj_bad', 200, '<html>not json</html>')
    await expect(api.getProject(account, 'pho_prj_bad')).rejects.toBeInstanceOf(PhotonApiError)
  })

  it('reports a missing project as null rather than throwing, so provisioning can create it', async () => {
    expect(await api.getProject(account, 'pho_prj_absent')).toBeNull()
  })
})

describe('provisioning is idempotent end to end', () => {
  it('returns the same project when the create is replayed with the same idempotency key', async () => {
    const first = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-scout',
      name: 'Scout',
      idempotencyKey: 'create-scout'
    })
    const replay = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-scout',
      name: 'Scout',
      idempotencyKey: 'create-scout'
    })
    expect(replay.id).toBe(first.id)
    expect(server.state.projects.size).toBe(1)
  })

  it('refuses a second project under a slug that is already taken', async () => {
    await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-taken',
      name: 'Taken',
      idempotencyKey: 'create-taken'
    })
    await expect(
      api.createProject({
        credential: account,
        organizationId: 'org_1',
        slug: 'orca-bot-taken',
        name: 'Taken',
        idempotencyKey: 'create-taken-again'
      })
    ).rejects.toMatchObject({ status: 409 })
  })

  it('returns the same secret when the key mint is replayed, and never a second key', async () => {
    const project = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-keyed',
      name: 'Keyed',
      idempotencyKey: 'create-keyed'
    })
    const minted = await api.mintProjectKey({
      credential: account,
      projectId: project.id,
      name: 'orca-bot',
      idempotencyKey: 'mint-keyed'
    })
    const replay = await api.mintProjectKey({
      credential: account,
      projectId: project.id,
      name: 'orca-bot',
      idempotencyKey: 'mint-keyed'
    })
    expect(replay).toEqual(minted)
    expect(server.state.keys.size).toBe(1)
  })

  it('gives the same number back when the assignment is replayed', async () => {
    const project = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-numbered',
      name: 'Numbered',
      idempotencyKey: 'create-numbered'
    })
    const projectCredential = { kind: 'project' as const, key: 'pho_sk_project' }
    const first = await api.createAssignment({
      credential: projectCredential,
      projectId: project.id,
      handle: '+15551230000',
      idempotencyKey: 'assign-numbered'
    })
    const replay = await api.createAssignment({
      credential: projectCredential,
      projectId: project.id,
      handle: '+15551230000',
      idempotencyKey: 'assign-numbered'
    })
    expect(replay).toEqual(first)
    expect(await api.listAssignments(projectCredential, project.id)).toEqual([first])
  })
})

describe('the send and the cleanup', () => {
  it('sends one message to the conversation it was given', async () => {
    const project = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-sender',
      name: 'Sender',
      idempotencyKey: 'create-sender'
    })
    await api.sendMessage({
      credential: { kind: 'project', key: 'pho_sk_project' },
      projectId: project.id,
      conversationId: 'conv_9',
      text: 'the build is green',
      idempotencyKey: 'send-1'
    })
    expect(server.state.sent).toMatchObject([
      { conversationId: 'conv_9', text: 'the build is green', idempotencyKey: 'send-1' }
    ])
  })

  it('reports a deletion as still closing until the closure reaches a terminal state', async () => {
    const project = await api.createProject({
      credential: account,
      organizationId: 'org_1',
      slug: 'orca-bot-closing',
      name: 'Closing',
      idempotencyKey: 'create-closing'
    })
    await api.deleteProject(account, project.id, 'delete-closing')
    expect(server.state.deleted).toContain(project.id)

    const first = await api.getProjectClosure(account, project.id)
    expect(first.state).toBe('closing')
    expect(photonClosureIsTerminal(first)).toBe(false)

    await api.getProjectClosure(account, project.id)
    const last = await api.getProjectClosure(account, project.id)
    expect(last.state).toBe('closed')
    expect(photonClosureIsTerminal(last)).toBe(true)
  })
})

describe('the slug', () => {
  it('is deterministic, lowercase and legal, so a retried provisioning finds one project', () => {
    expect(photonSlugForBot('Scout')).toBe('orca-bot-scout')
    expect(photonSlugForBot('Scout')).toBe(photonSlugForBot('Scout'))
    expect(photonSlugForBot('My  Bot!!')).toBe('orca-bot-my-bot')
  })

  it('stays inside the 3–63 character window for a name with no usable characters', () => {
    const slug = photonSlugForBot('!!!')
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(slug.length).toBeGreaterThanOrEqual(3)
    expect(slug.length).toBeLessThanOrEqual(PHOTON_SLUG_MAX)
    // Two odd names must not land on one slug: the slug is immutable and can never be reused.
    expect(photonSlugForBot('???')).not.toBe(slug)
  })
})
