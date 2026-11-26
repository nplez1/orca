import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from './runtime-environment-store-operations'
import { renameEnvironment } from './runtime-environment-rename'

const offer = (seed: number): string =>
  encodePairingOffer({
    v: 2,
    endpoint: 'wss://server.example/runtime',
    publicKeyB64: Buffer.alloc(32, seed).toString('base64'),
    deviceToken: `private-device-token-${seed}`,
    pairedDeviceId: `paired-client-${seed}`
  })

describe('renaming a saved server', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-rename-'))
  })
  afterEach(async () => {
    await removeTempDirs([userDataPath])
  })

  function add(name: string, seed: number): string {
    return addEnvironmentFromPairingCode(userDataPath, { name, pairingCode: offer(seed) }).id
  }

  it('keeps the id and the pairing, and changes only the name', async () => {
    const id = add('Mesh host 8f3ac2b1', 3)

    const renamed = renameEnvironment(userDataPath, id, { name: '  Build mini  ' })

    expect(renamed.changed).toBe(true)
    expect(renamed.environment.id).toBe(id)
    expect(renamed.environment.name).toBe('Build mini')
    const [stored] = listEnvironments(userDataPath)
    expect(stored?.name).toBe('Build mini')
    expect(stored?.id).toBe(id)
  })

  it('refuses a name another server already has, unless the caller allows a suffix', async () => {
    add('Studio', 4)
    const id = add('Laptop', 5)

    expect(() => renameEnvironment(userDataPath, id, { name: 'studio' })).toThrow()

    const suffixed = renameEnvironment(userDataPath, id, { name: 'Studio', disambiguate: true })
    expect(suffixed.environment.name).toBe('Studio (2)')
  })

  it('refuses a blank name', async () => {
    const id = add('Laptop', 6)

    expect(() => renameEnvironment(userDataPath, id, { name: '   ' })).toThrow()
  })
})
