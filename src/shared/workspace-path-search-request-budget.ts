import type {
  WorkspacePathSearchCapabilityDescriptor,
  WorkspacePathSearchRequest
} from './workspace-path-search-contract'

export function limitWorkspacePathSearchRequestToCapability(
  request: WorkspacePathSearchRequest,
  descriptor: WorkspacePathSearchCapabilityDescriptor
): WorkspacePathSearchRequest {
  return {
    ...request,
    identity: {
      ...request.identity,
      pageBudget: {
        maxPaths: Math.min(request.identity.pageBudget.maxPaths, descriptor.maxPagePaths),
        maxSerializedBytes: Math.min(
          request.identity.pageBudget.maxSerializedBytes,
          descriptor.maxPageSerializedBytes
        )
      }
    }
  }
}
