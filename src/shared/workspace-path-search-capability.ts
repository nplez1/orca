import { z } from 'zod'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from './remote-rpc-content-budget'
import { MAX_MESSAGE_SIZE } from './relay-frame-decoder'
import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY,
  type WorkspacePathSearchCapabilityDescriptor
} from './workspace-path-search-contract'

export const WORKSPACE_PATH_SEARCH_MATCHER_VERSION = 1
export const WORKSPACE_PATH_SEARCH_MAX_PAGE_PATHS =
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS
export const WORKSPACE_PATH_SEARCH_RELAY_MAX_PAGE_BYTES = MAX_MESSAGE_SIZE - 64 * 1024

export const RUNTIME_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR = {
  matcherVersion: WORKSPACE_PATH_SEARCH_MATCHER_VERSION,
  supportedScopes: ['included', 'all'],
  supportsDotfileVisibility: true,
  supportsIgnoredFileVisibility: true,
  supportsExcludePathSegments: true,
  maxPagePaths: WORKSPACE_PATH_SEARCH_MAX_PAGE_PATHS,
  maxPageSerializedBytes: REMOTE_RPC_MAX_CONTENT_BYTES,
  freshnessMetadata: true
} as const satisfies WorkspacePathSearchCapabilityDescriptor

export const RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR = {
  ...RUNTIME_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
  supportsDotfileVisibility: true,
  maxPageSerializedBytes: WORKSPACE_PATH_SEARCH_RELAY_MAX_PAGE_BYTES
} as const satisfies WorkspacePathSearchCapabilityDescriptor

export const WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY =
  WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY

const WorkspacePathSearchCapabilityDescriptorSchema = z.object({
  matcherVersion: z.literal(1),
  supportedScopes: z.array(z.enum(['included', 'all'])),
  supportsDotfileVisibility: z.boolean(),
  supportsIgnoredFileVisibility: z.boolean(),
  supportsExcludePathSegments: z.boolean(),
  maxPagePaths: z.number().int().positive(),
  maxPageSerializedBytes: z.number().int().positive(),
  freshnessMetadata: z.boolean()
})

export function parseWorkspacePathSearchCapabilityDescriptor(
  value: unknown
): WorkspacePathSearchCapabilityDescriptor | null {
  const parsed = WorkspacePathSearchCapabilityDescriptorSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
