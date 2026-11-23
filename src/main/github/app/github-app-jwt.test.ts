import { generateKeyPairSync, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signGithubAppJwt } from './github-app-jwt'

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

describe('signGithubAppJwt', () => {
  it('signs a verifiable RS256 JWT whose claims GitHub will accept', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const nowMs = 1_700_000_000_000

    const jwt = signGithubAppJwt(5739055, pem, nowMs)
    const [header, payload, signature] = jwt.split('.')

    expect(decodePart(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decodePart(payload)).toEqual({ iat: 1_699_999_940, exp: 1_700_000_480, iss: 5739055 })

    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(
      verifier.verify(
        publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        signature,
        'base64url'
      )
    ).toBe(true)
  })

  it('refuses an id that is not a positive integer, rather than signing a JWT GitHub will 404 on', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

    expect(() => signGithubAppJwt(Number.NaN, pem, 0)).toThrow(/positive integer/)
    expect(() => signGithubAppJwt(0, pem, 0)).toThrow(/positive integer/)
  })
})
