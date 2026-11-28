import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import { PhotonStore } from './photon-store'
import { PHOTON_DIR, RECORD_FILE, photonSpectrumSecretsPath } from './photon-store-paths'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-spectrum-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a bot answering on an existing Spectrum project', () => {
  it('keeps the project id in the record and the secret sealed in its own file, never in the record', async () => {
    const first = new PhotonStore(userDataPath)
    await first.putBot({
      mode: 'spectrum',
      botId: 'b1',
      projectId: 'pho_prj_1',
      slug: 'my-project'
    })
    await new PhotonSpectrumSecrets(userDataPath).put('b1', {
      projectId: 'pho_prj_1',
      secret: 'pho_sk_project_secret'
    })

    const restarted = new PhotonStore(userDataPath)
    const record = await restarted.bot('b1')
    expect(record).toMatchObject({
      mode: 'spectrum',
      projectId: 'pho_prj_1',
      slug: 'my-project',
      released: false,
      assignments: []
    })
    // Neither exists for a project Orca did not provision, so a reader must not be handed a placeholder.
    expect(record?.organizationId).toBeUndefined()
    expect(record?.keyId).toBeUndefined()
    expect(await new PhotonSpectrumSecrets(userDataPath).secret('b1')).toEqual({
      projectId: 'pho_prj_1',
      secret: 'pho_sk_project_secret'
    })
    // The project id is ordinary state; the secret is only ever written sealed, and never beside it.
    expect(readFileSync(restarted.recordPath, 'utf-8')).not.toContain('pho_sk_project_secret')
    expect(readFileSync(photonSpectrumSecretsPath(userDataPath), 'utf-8')).toMatch(
      /"secret":\s*"(sealed|plain):/
    )
  })

  it('parses a record written before the mode field existed as account mode', async () => {
    mkdirSync(join(userDataPath, PHOTON_DIR), { recursive: true })
    writeFileSync(
      join(userDataPath, PHOTON_DIR, RECORD_FILE),
      JSON.stringify({
        bots: [
          {
            botId: 'b_old',
            projectId: 'prj_old',
            slug: 'orca-bot-old',
            organizationId: 'org_1',
            keyId: 'key_1',
            completedThrough: 'assignment',
            createdAt: 1
          }
        ]
      })
    )

    const store = new PhotonStore(userDataPath)
    const record = await store.bot('b_old')
    expect(record?.mode).toBe('account')
    expect(record).toMatchObject({
      slug: 'orca-bot-old',
      organizationId: 'org_1',
      keyId: 'key_1',
      completedThrough: 'assignment'
    })
    expect(store.unreadable.record).toBe(false)
  })

  it('holds a secret for the session without writing one, which is what "not stored" means', async () => {
    const store = new PhotonStore(userDataPath)
    const secrets = new PhotonSpectrumSecrets(userDataPath)
    await store.putBot({ mode: 'spectrum', botId: 'b1', projectId: 'pho_prj_1' })

    secrets.holdForSession('b1', { projectId: 'pho_prj_1', secret: 'pho_sk_project_secret' })

    expect(await secrets.secret('b1')).toEqual({
      projectId: 'pho_prj_1',
      secret: 'pho_sk_project_secret'
    })
    // Nothing reached the disk, and the next run is told to paste it again rather than failing quietly.
    expect(await new PhotonSpectrumSecrets(userDataPath).secret('b1')).toBeNull()
  })

  it('forgets the sealed secret when the channel is released, leaving no project id behind', async () => {
    const store = new PhotonStore(userDataPath)
    const secrets = new PhotonSpectrumSecrets(userDataPath)
    await store.putBot({ mode: 'spectrum', botId: 'b1', projectId: 'pho_prj_1' })
    await secrets.put('b1', { projectId: 'pho_prj_1', secret: 'pho_sk_project_secret' })

    await secrets.forget('b1')

    expect(await new PhotonSpectrumSecrets(userDataPath).secret('b1')).toBeNull()
    expect(readFileSync(photonSpectrumSecretsPath(userDataPath), 'utf-8')).not.toContain(
      'pho_prj_1'
    )
  })
})
