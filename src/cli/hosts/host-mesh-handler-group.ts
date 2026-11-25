import type { HandlerGroup } from '../dispatch/handler-group-manifest'

/**
 * The `group` commands, as one manifest entry.
 *
 * Why this file exists rather than an inline object in the upstream manifest: a fork-owned constant is one
 * line there instead of six, and the lazy `load` still keeps the handlers out of startup for anyone who
 * never runs a `group` command.
 */
export const HOST_MESH_HANDLER_GROUP: HandlerGroup = {
  name: 'host-mesh',
  keys: ['group status', 'group join', 'group sync', 'group remove', 'group leave'],
  load: async () => (await import('./host-mesh.js')).HOST_MESH_HANDLERS
}
