import type { HandlerGroup } from '../dispatch/handler-group-manifest'

/** Hidden: git runs these through credential.helper, so nobody types one. */
export const GIT_CREDENTIAL_HANDLER_GROUP: HandlerGroup = {
  name: 'git-credential',
  keys: ['git-credential get', 'git-credential store', 'git-credential erase'],
  load: async () => (await import('./git-credential.js')).GIT_CREDENTIAL_HANDLERS
}
