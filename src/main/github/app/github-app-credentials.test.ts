import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  githubAppCredentialsPath,
  readGithubAppCredentials,
  writeGithubAppCredentials
} from './github-app-credentials'

/** The sealed ciphertext of the key, which a parser message must never quote back at the renderer. */
const CORRUPT = '{"version":1,"appId":5739055,"slug":"lab-agent-np","privateKey":"sealed:AAA'

describe('readGithubAppCredentials', () => {
  it('says a corrupt file is unreadable without quoting it, because what it quotes is sealed', async () => {
    mkdirSync(dirname(githubAppCredentialsPath()), { recursive: true })
    writeFileSync(githubAppCredentialsPath(), CORRUPT)

    await expect(readGithubAppCredentials()).rejects.toThrow(
      'github-app: the stored App credentials are not readable; connect the App again'
    )
    await expect(readGithubAppCredentials()).rejects.not.toThrow(/sealed:AAA/)
  })

  it('refuses a key that was not sealed, rather than trusting a file Orca never writes', async () => {
    mkdirSync(dirname(githubAppCredentialsPath()), { recursive: true })
    writeFileSync(
      githubAppCredentialsPath(),
      JSON.stringify({
        version: 1,
        appId: 5739055,
        slug: 'lab-agent-np',
        privateKey: `plain:${Buffer.from('-----BEGIN RSA PRIVATE KEY-----').toString('base64')}`,
        installations: []
      })
    )

    await expect(readGithubAppCredentials()).rejects.toThrow(/not readable/)
  })

  it('reads back what was written, with the key unsealed', async () => {
    await writeGithubAppCredentials({
      appId: 5739055,
      slug: 'lab-agent-np',
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
      installations: [
        { id: 181472560, account: 'nplez1', repositorySelection: 'all', repositories: [] }
      ]
    })

    await expect(readGithubAppCredentials()).resolves.toMatchObject({
      appId: 5739055,
      slug: 'lab-agent-np',
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n'
    })
  })
})
