// `github.app.*`: the App a bot can act as on this host, and the only place its key is ever accepted.
import { GithubAppConnect } from '../../../../../../shared/rpc-contract/github/github-app-params'
import {
  connectGithubApp,
  disconnectGithubApp,
  githubAppStatus
} from '../../../../../github/app/github-app-connection'
import { electronHttpClient } from '../../../../../host/electron-http-client'
import { defineMethod } from '../../../core'

export const GITHUB_APP_METHODS = [
  // A credential, so accounts-admin; the answer carries the identity, never the key or a token.
  defineMethod({
    name: 'github.app.status',
    permission: 'accounts-admin',
    params: null,
    handler: async () => githubAppStatus()
  }),
  defineMethod({
    name: 'github.app.connect',
    permission: 'accounts-admin',
    params: GithubAppConnect,
    handler: async ({ appId, privateKey }) =>
      connectGithubApp({ appId, privateKey, fetch: electronHttpClient.fetch })
  }),
  defineMethod({
    name: 'github.app.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async () => disconnectGithubApp()
  })
]
