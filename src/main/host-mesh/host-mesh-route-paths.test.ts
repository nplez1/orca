import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRemoteRuntimeE2EEV2HostLatch } from '../../shared/remote-runtime/e2ee/node/remote-runtime-e2ee-v2-host-latch'
import { addEnvironmentFromPairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { E2EEChannel } from '../runtime/rpc/mobile/e2ee/e2ee-channel'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { relocatePairingEndpoint } from './host-mesh-pairing-endpoint'
import { adoptFirstReachable, probePairingEndpoint } from './host-mesh-route-paths'

const ENDPOINT = 'ws://10.0.0.9:6768'
const TOKEN = 'right-token'

let userDataPath = ''
const openServers: (() => Promise<void>)[] = []

function offer(seed: number, publicKeyB64 = Buffer.alloc(32, seed).toString('base64')): string {
  return encodePairingOffer({
    v: 2,
    endpoint: ENDPOINT,
    publicKeyB64,
    deviceToken: TOKEN,
    pairedDeviceId: `paired-client-${seed}`
  })
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-mesh-route-paths-'))
  configureRemoteRuntimeE2EEV2HostLatch(userDataPath)
})

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()))
  configureRemoteRuntimeE2EEV2HostLatch(null)
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A host that answers only the credential it was started with, which is the whole point of the probe. */
async function startHost(args: {
  accepts: string
}): Promise<{ endpoint: string; publicKeyB64: string }> {
  const keyPair = nacl.box.keyPair()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (ws) => {
    const channel = new E2EEChannel(ws, {
      serverSecretKey: keyPair.secretKey,
      resolveAuthenticatedDevice: (candidate) =>
        candidate === args.accepts
          ? {
              deviceId: 'device-1',
              scope: 'runtime',
              clientId: candidate,
              callerFingerprint: 'fingerprint',
              credentialRevision: 0,
              deviceToken: candidate
            }
          : null,
      onError: (code, reason) => ws.close(code, reason),
      onReady: () => {}
    })
    channel.onMessage((plaintext, reply) => {
      const frame: Record<string, unknown> = JSON.parse(plaintext)
      reply(JSON.stringify({ id: frame.id, _meta: { runtimeId: 'r' }, ok: true, result: {} }))
    })
    ws.on('message', (data: Buffer) => channel.handleRawMessage(data.toString()))
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  openServers.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) {
          client.terminate()
        }
        server.close(() => resolve())
      })
  )
  // Why the host's own key travels back: a pairing row pins the key it will trust, and the probe is only meaningful
  // against a row that pins this server's.
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    publicKeyB64: Buffer.from(keyPair.publicKey).toString('base64')
  }
}

describe('adopting a route that answers', () => {
  const deps = (args: {
    current?: string | null
    answers?: readonly string[]
    movable?: boolean
  }) => ({
    current: async () => args.current ?? null,
    isFixedEndpoint: async () => false,
    probe: async (endpoint: string) => (args.answers ?? []).includes(endpoint),
    relocate: async () => args.movable ?? true
  })

  it('skips the address it already dials, so a failed path is never tried twice', async () => {
    const probed: string[] = []
    const adopted = await adoptFirstReachable(
      {
        ...deps({ current: 'ws://10.0.0.9:6768', answers: ['ws://10.0.0.4:6768'] }),
        probe: async (endpoint) => {
          probed.push(endpoint)
          return endpoint === 'ws://10.0.0.4:6768'
        }
      },
      ['ws://10.0.0.9:6768', 'ws://10.0.0.4:6768']
    )

    expect(adopted).toBe('ws://10.0.0.4:6768')
    expect(probed).toEqual(['ws://10.0.0.4:6768'])
  })

  it('never dials a value that is not an endpoint, so a bad route costs no timeout', async () => {
    const probed: string[] = []
    const adopted = await adoptFirstReachable(
      {
        ...deps({}),
        probe: async (endpoint) => {
          probed.push(endpoint)
          return true
        }
      },
      ['http://10.0.0.4:6768', 'ws://user:pass@10.0.0.4:6768', 'ws://10.0.0.5:6768']
    )

    expect(adopted).toBe('ws://10.0.0.5:6768')
    expect(probed).toEqual(['ws://10.0.0.5:6768'])
  })

  it('keeps looking when a path answers but the row cannot move to it', async () => {
    const adopted = await adoptFirstReachable(
      {
        ...deps({ answers: ['ws://10.0.0.4:6768', 'ws://10.0.0.5:6768'] }),
        relocate: async (endpoint) => endpoint === 'ws://10.0.0.5:6768'
      },
      ['ws://10.0.0.4:6768', 'ws://10.0.0.5:6768']
    )

    expect(adopted).toBe('ws://10.0.0.5:6768')
  })

  it('adopts nothing when no route answers', async () => {
    const adopted = await adoptFirstReachable(deps({}), ['ws://10.0.0.4:6768'])
    expect(adopted).toBeNull()
  })

  it('never moves a row whose address is not its own to move', async () => {
    // Why before the probe: a tunnel's local port, an access link's loopback and a managed deployment's address are
    // all pinned by the schema that owns them, so a rewrite there loses the row rather than repairing it.
    const probed: string[] = []
    const adopted = await adoptFirstReachable(
      {
        ...deps({ answers: ['ws://10.0.0.4:6768'] }),
        isFixedEndpoint: async () => true,
        probe: async (endpoint) => {
          probed.push(endpoint)
          return true
        }
      },
      ['ws://10.0.0.4:6768']
    )

    expect(adopted).toBeNull()
    expect(probed).toEqual([])
  })
})

describe('probing a route with the pairing’s own credential', () => {
  it('accepts the address that answers as this host', async () => {
    const host = await startHost({ accepts: TOKEN })
    const { id } = addEnvironmentFromPairingCode(userDataPath, {
      name: 'studio',
      pairingCode: offer(1, host.publicKeyB64)
    })

    await expect(probePairingEndpoint(userDataPath, id, host.endpoint)).resolves.toBe(true)
  })

  it('refuses an address that answers only some other machine’s credential', async () => {
    const host = await startHost({ accepts: 'someone-elses-token' })
    const { id } = addEnvironmentFromPairingCode(userDataPath, {
      name: 'studio',
      pairingCode: offer(1, host.publicKeyB64)
    })

    await expect(probePairingEndpoint(userDataPath, id, host.endpoint)).resolves.toBe(false)
  })
})

describe('moving a pairing row to a new address', () => {
  it('keeps the credential and the pairing revision, and moves only the address', async () => {
    const { id } = addEnvironmentFromPairingCode(userDataPath, {
      name: 'studio',
      pairingCode: offer(2)
    })
    const before = await resolveEnvironment(userDataPath, id)

    const moved = relocatePairingEndpoint({
      userDataPath,
      environmentId: id,
      endpoint: 'ws://10.0.0.44:6768',
      now: before.updatedAt + 1_000
    })

    expect(moved).toBe(true)
    const after = await resolveEnvironment(userDataPath, id)
    expect(after.endpoints[0]?.endpoint).toBe('ws://10.0.0.44:6768')
    // The two facts a re-pairing would change, and an address move must not: the token every dial uses, and the
    // revision worker stop/observe and the automation owner keys pin.
    expect(after.endpoints[0]?.deviceToken).toBe(before.endpoints[0]?.deviceToken)
    expect(after.pairingRevision).toBe(before.pairingRevision)
  })

  it('reports the row as unmoveable when there is no pairing for it', async () => {
    const moved = relocatePairingEndpoint({
      userDataPath,
      environmentId: 'missing',
      endpoint: 'ws://10.0.0.44:6768',
      now: 1
    })

    expect(moved).toBe(false)
  })
})
