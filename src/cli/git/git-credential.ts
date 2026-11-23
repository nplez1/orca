// `orca git-credential …`: git's own credential-helper protocol, so a push acts as the GitHub App a
// project is bound to. The token is minted here, at the moment git asks, and printed only to git.
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import type { GithubAppGitCredentialResult } from '../../shared/rpc-contract/github/github-app-params'
import { RuntimeClientError } from '../runtime/connection/types'

/**
 * git writes `key=value` lines then a blank line. Nothing here reads a field: the project's own binding
 * decides which identity answers, so the request is drained rather than parsed.
 */
async function drainCredentialRequest(stream: NodeJS.ReadableStream): Promise<void> {
  stream.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of stream) {
    buffer += String(chunk)
    if (buffer.includes('\n\n')) {
      return
    }
  }
}

const answer: CommandHandler = async ({ client, flags, cwd }) => {
  await drainCredentialRequest(process.stdin)
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
  await drainCredentialRequest(process.stdin)
}

export const GIT_CREDENTIAL_HANDLERS: Record<string, CommandHandler> = {
  'git-credential get': answer,
  'git-credential store': keepNothing(),
  'git-credential erase': keepNothing()
}
