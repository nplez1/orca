// `orca git-credential …`: git's own credential-helper protocol, so a push acts as the GitHub App a
// project is bound to. The token is minted here, at the moment git asks, and printed only to git.
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import type { GithubAppGitCredentialResult } from '../../shared/rpc-contract/github/github-app-params'
import { GITHUB_APP_HOST } from '../../shared/github/app/github-app-identity'
import { RuntimeClientError } from '../runtime/connection/types'

/**
 * git writes `key=value` lines then a blank line. Only `host` is read: the project's binding picks the
 * identity, but a helper answers for every host git contacts, and the App's token belongs to one.
 */
export async function readCredentialRequestHost(
  stream: NodeJS.ReadableStream
): Promise<string | undefined> {
  stream.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of stream) {
    buffer += String(chunk)
    if (buffer.includes('\n\n')) {
      break
    }
  }
  for (const line of buffer.split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key === 'host') {
      return rest.join('=').trim().toLowerCase()
    }
  }
  return undefined
}

/** A request for another host gets no answer: git then fails to authenticate there instead of leaking the App's token. */
export function answersCredentialHost(host: string | undefined): boolean {
  return host === undefined || host.length === 0 || host === GITHUB_APP_HOST
}

const answer: CommandHandler = async ({ client, flags, cwd }) => {
  if (!answersCredentialHost(await readCredentialRequestHost(process.stdin))) {
    return
  }
  const folder = resolve(cwd, getRequiredStringFlag(flags, 'repo'))
  const response = await client.call<GithubAppGitCredentialResult>('github.app.gitCredential', {
    repo: `path:${folder}`
  })
  const { username, password } = response.result
  if (!password) {
    // An empty password makes git report the push as unauthenticated instead of retrying as the user.
    throw new RuntimeClientError(
      'internal',
      'Orca answered git with no App token, so this push cannot act as the GitHub App.'
    )
  }
  process.stdout.write(`username=${username}\npassword=${password}\n`)
}

/** git calls `store` after a successful request and `erase` after one it gave up on; both keep nothing. */
const keepNothing = (): CommandHandler => async () => {
  await readCredentialRequestHost(process.stdin)
}

export const GIT_CREDENTIAL_HANDLERS: Record<string, CommandHandler> = {
  'git-credential get': answer,
  'git-credential store': keepNothing(),
  'git-credential erase': keepNothing()
}
