import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type {
  WorkspacePathSearchCapabilityDescriptor,
  WorkspacePathSearchRequest,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import { parseWorkspacePathSearchWireResponse } from '../../shared/workspace-path-search-wire-response'
import { probeSshWorkspacePathSearchCapability } from './ssh-filesystem-provider-capabilities'

export async function searchSshWorkspacePathNameFilter(
  mux: SshChannelMultiplexer,
  rootPath: string,
  request: WorkspacePathSearchRequest,
  signal?: AbortSignal
): Promise<WorkspacePathSearchResponse | null> {
  const descriptor = await probeSshWorkspacePathSearchCapability(mux, signal)
  if (!supportsRequest(descriptor, request)) {
    return null
  }
  const result = await mux.request(
    'fs.searchPaths',
    { rootPath, request },
    { signal, timeoutMs: 30_000 }
  )
  return parseWorkspacePathSearchWireResponse(result, request.identity)
}

function supportsRequest(
  descriptor: WorkspacePathSearchCapabilityDescriptor | null,
  request: WorkspacePathSearchRequest
): descriptor is WorkspacePathSearchCapabilityDescriptor {
  return (
    descriptor !== null &&
    descriptor.matcherVersion === 1 &&
    descriptor.supportedScopes.includes(request.identity.scope.pathSet) &&
    (request.identity.scope.includeDotfiles || descriptor.supportsDotfileVisibility) &&
    descriptor.supportsIgnoredFileVisibility &&
    (request.identity.scope.excludePathSegments.length === 0 ||
      descriptor.supportsExcludePathSegments) &&
    request.identity.pageBudget.maxPaths <= descriptor.maxPagePaths &&
    request.identity.pageBudget.maxSerializedBytes <= descriptor.maxPageSerializedBytes
  )
}
