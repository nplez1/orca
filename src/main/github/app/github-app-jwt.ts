import { createSign } from 'node:crypto'
import { githubAppJwtClaims } from '../../../shared/github/app/github-app-identity'

const HEADER = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')

/**
 * Sign the App's JWT with RS256. Node signs directly, so no `openssl` child process is involved — and the key
 * never leaves this process. The result is the only thing that ever travels, and it expires within ten minutes.
 */
export function signGithubAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('github-app: the app id must be a positive integer')
  }
  const claims = githubAppJwtClaims(appId, nowMs)
  const unsigned = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  return `${unsigned}.${signer.sign(privateKeyPem, 'base64url')}`
}
