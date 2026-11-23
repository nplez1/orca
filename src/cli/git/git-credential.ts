// `orca git-credential …`: git's own credential-helper protocol, so a push acts as the GitHub App a
// project is bound to. The token is minted here, at the moment git asks, and printed only to git.
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import type { GithubAppGitCredentialResult } from '../../shared/rpc-contract/github/github-app-params'
import { GITHUB_APP_HOST } from '../../shared/github/app/github-app-identity'
import { RuntimeClientError } from '../runtime/connection/types'

/** git writes `key=value` lines then a blank line; the first block is the request, and later ones are not. */
export async function readCredentialRequest(
  stream: NodeJS.ReadableStream
): Promise<Record<string, string>> {
  stream.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of stream) {
    buffer += String(chunk)
    if (buffer.includes('\n\n')) {
      break
    }
  }
  const fields: Record<string, string> = {}
  const end = buffer.indexOf('\n\n')
  for (const line of (end === -1 ? buffer : buffer.slice(0, end)).split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return fields
}

/**
 * Whether the App can answer this request at all. It has to name github.com over https, and the repository:
 * the installation token acts on every repository the installation covers, and a request that names none
 * cannot be scoped to the project's own.
 */
export function answersCredentialRequest(request: Record<string, string>): boolean {
  return request.protocol === 'https' && request.host === GITHUB_APP_HOST && Boolean(request.path)
}

export type GitCredentialAnswer = {
  request: Record<string, string>
  folder: string
  call: (params: { repo: string; path: string }) => Promise<GithubAppGitCredentialResult>
  write: (text: string) => void
}

/** Answers `get` on stdout, or answers nothing at all: git then fails rather than falling back to the user. */
export async function answerGitCredentialRequest(input: GitCredentialAnswer): Promise<void> {
  if (!answersCredentialRequest(input.request)) {
    return
  }
  const { username, password } = await input.call({
    repo: `path:${input.folder}`,
    path: input.request.path
  })
  if (!password) {
    // An empty password makes git report the push as unauthenticated instead of retrying as the user.
    throw new RuntimeClientError(
      'internal',
      'Orca answered git with no App token, so this push cannot act as the GitHub App.'
    )
  }
  input.write(`username=${username}\npassword=${password}\n`)
}

const answer: CommandHandler = async ({ client, flags, cwd }) => {
  const request = await readCredentialRequest(process.stdin)
  await answerGitCredentialRequest({
    request,
    folder: resolve(cwd, getRequiredStringFlag(flags, 'repo')),
    call: async (params) =>
      (await client.call<GithubAppGitCredentialResult>('github.app.gitCredential', params)).result,
    write: (text) => process.stdout.write(text)
  })
}

/** git calls `store` after a successful request and `erase` after one it gave up on; both keep nothing. */
const keepNothing = (): CommandHandler => async () => {
  await readCredentialRequest(process.stdin)
}

export const GIT_CREDENTIAL_HANDLERS: Record<string, CommandHandler> = {
  'git-credential get': answer,
  'git-credential store': keepNothing(),
  'git-credential erase': keepNothing()
}
