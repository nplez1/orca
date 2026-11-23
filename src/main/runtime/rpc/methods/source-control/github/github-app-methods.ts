// `github.app.*`: the App a bot can act as on this host, and the only place its key is ever accepted.
import { GithubAppConnect } from '../../../../../../shared/rpc-contract/github/github-app-params'
import {
  connectGithubApp,
  disconnectGithubApp,
  githubAppStatus,
  refreshGithubApp
} from '../../../../../github/app/github-app-connection'
import { electronHttpClient } from '../../../../../host/electron-http-client'
import { defineMethod } from '../../../core'

/** Main tags its own messages `github-app:` for the log; a person reading one needs it without. */
const GITHUB_APP_PREFIX = /^github-app:\s*/

function withoutPrefix(message: string): string {
  return message.replace(GITHUB_APP_PREFIX, '')
}

function forTheUser(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof Error && withoutPrefix(message) === message
    ? error
    : new Error(withoutPrefix(message))
}

async function answered<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw forTheUser(error)
  }
}

export const GITHUB_APP_METHODS = [
  // A credential, so accounts-admin; the answer carries the identity, never the key or a token.
  defineMethod({
    name: 'github.app.status',
    permission: 'accounts-admin',
    params: null,
    handler: async () => {
      const status = await githubAppStatus()
      return !status.connected && status.unreadable
        ? { ...status, unreadable: withoutPrefix(status.unreadable) }
        : status
    }
  }),
  defineMethod({
    name: 'github.app.connect',
    permission: 'accounts-admin',
    params: GithubAppConnect,
    handler: async ({ appId, privateKey }) =>
      answered(() => connectGithubApp({ appId, privateKey, fetch: electronHttpClient.fetch }))
  }),
  // A repository added to an installation, or a second installation, without a second paste.
  defineMethod({
    name: 'github.app.refresh',
    permission: 'accounts-admin',
    params: null,
    handler: async () => answered(() => refreshGithubApp({ fetch: electronHttpClient.fetch }))
  }),
  defineMethod({
    name: 'github.app.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async () => answered(() => disconnectGithubApp({ fetch: electronHttpClient.fetch }))
  })
]
