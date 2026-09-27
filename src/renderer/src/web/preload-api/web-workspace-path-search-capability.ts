import type { WorkspacePathSearchCapabilityDescriptor } from '../../../../shared/workspace-path-search-contract'
import { WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY } from '../../../../shared/workspace-path-search-contract'
import { parseWorkspacePathSearchCapabilityDescriptor } from '../../../../shared/workspace-path-search-capability'
import {
  observeWebRuntimeStatus,
  requireActiveEnvironment,
  subscribeWebRuntimeStatus
} from './web-runtime-session'

const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 16
const capabilities = new Map<
  string,
  { expiresAt: number; result: Promise<WebWorkspacePathSearchCapability> }
>()

subscribeWebRuntimeStatus((snapshot) => {
  const prefix = `${snapshot.environmentId}\u0000`
  if (snapshot.verification !== 'verified' || snapshot.status === null) {
    for (const key of capabilities.keys()) {
      if (key.startsWith(prefix)) {
        capabilities.delete(key)
      }
    }
    return
  }
  for (const [key, cached] of capabilities) {
    if (key.startsWith(prefix)) {
      void cached.result.then((capability) => {
        if (capability.incarnationId !== snapshot.status?.runtimeId) {
          capabilities.delete(key)
        }
      })
    }
  }
})

export type WebWorkspacePathSearchCapability = {
  descriptor: WorkspacePathSearchCapabilityDescriptor | null
  incarnationId: string
}

export function readWebWorkspacePathSearchCapability(): Promise<WebWorkspacePathSearchCapability> {
  const environment = requireActiveEnvironment()
  const revision = environment.pairingRevision ?? environment.createdAt
  const key = `${environment.id}\u0000${revision}`
  const cached = capabilities.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }

  const result = probeWebWorkspacePathSearchCapability(environment.id)
  capabilities.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result })
  while (capabilities.size > CACHE_MAX_ENTRIES) {
    const oldest = capabilities.keys().next().value
    if (oldest === undefined) {
      break
    }
    capabilities.delete(oldest)
  }
  void result.catch(() => {
    if (capabilities.get(key)?.result === result) {
      capabilities.delete(key)
    }
  })
  return result
}

async function probeWebWorkspacePathSearchCapability(
  environmentId: string
): Promise<WebWorkspacePathSearchCapability> {
  const response = await observeWebRuntimeStatus(environmentId)
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  const status = response.result
  const advertised = status.capabilities?.includes(WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY)
  return {
    descriptor: advertised
      ? parseWorkspacePathSearchCapabilityDescriptor(
          status.pathSearchCapabilities?.[WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY]
        )
      : null,
    incarnationId: status.runtimeId
  }
}
