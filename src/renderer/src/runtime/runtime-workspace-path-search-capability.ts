import { z } from 'zod'
import {
  WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY,
  type WorkspacePathSearchCapabilityDescriptor
} from '../../../shared/workspace-path-search-contract'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  clearRuntimeCompatibilityCache,
  getCachedRuntimeEnvironmentStatus,
  runtimeEnvironmentSupportsCapability,
  subscribeRuntimeWorkspacePathSearchCapabilityInvalidation
} from './runtime-rpc-client'

const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 32
const capabilityCache = new Map<
  string,
  { expiresAt: number; result: Promise<RuntimeWorkspacePathSearchCapability | null> }
>()
const pairingRevisionByEnvironment = new Map<string, string>()

subscribeRuntimeWorkspacePathSearchCapabilityInvalidation((environmentId) => {
  if (environmentId === null) {
    capabilityCache.clear()
    return
  }
  for (const key of capabilityCache.keys()) {
    if (key.startsWith(`${environmentId}\u0000`)) {
      capabilityCache.delete(key)
    }
  }
})

export type RuntimeWorkspacePathSearchCapability = {
  descriptor: WorkspacePathSearchCapabilityDescriptor | null
  incarnationId: string
}

const CapabilityDescriptorSchema = z.object({
  matcherVersion: z.literal(1),
  supportedScopes: z.array(z.enum(['included', 'all'])),
  supportsDotfileVisibility: z.boolean(),
  supportsIgnoredFileVisibility: z.boolean(),
  supportsExcludePathSegments: z.boolean(),
  maxPagePaths: z.number().int().positive(),
  maxPageSerializedBytes: z.number().int().positive(),
  freshnessMetadata: z.boolean()
})

export function readRuntimeWorkspacePathSearchCapability(
  environmentId: string
): Promise<RuntimeWorkspacePathSearchCapability | null> {
  const revision = String(getRuntimeEnvironmentRevision(environmentId) ?? 'unknown-revision')
  const previousRevision = pairingRevisionByEnvironment.get(environmentId)
  if (previousRevision !== undefined && previousRevision !== revision) {
    clearRuntimeCompatibilityCache(environmentId)
  }
  pairingRevisionByEnvironment.set(environmentId, revision)
  const key = `${environmentId}\u0000${revision}`
  const cached = capabilityCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    capabilityCache.delete(key)
    capabilityCache.set(key, cached)
    return cached.result
  }

  capabilityCache.delete(key)
  const result = resolveRuntimeWorkspacePathSearchCapability(environmentId)
  capabilityCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result })
  while (capabilityCache.size > CACHE_MAX_ENTRIES) {
    const oldest = capabilityCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    capabilityCache.delete(oldest)
  }
  void result.catch(() => {
    if (capabilityCache.get(key)?.result === result) {
      capabilityCache.delete(key)
    }
  })
  return result
}

async function resolveRuntimeWorkspacePathSearchCapability(
  environmentId: string
): Promise<RuntimeWorkspacePathSearchCapability | null> {
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY
  )
  const status = getCachedRuntimeEnvironmentStatus(environmentId)
  if (!status) {
    return null
  }
  if (!supported || !status.capabilities?.includes(WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY)) {
    return { descriptor: null, incarnationId: status.runtimeId }
  }
  const descriptor = CapabilityDescriptorSchema.safeParse(
    status.pathSearchCapabilities?.[WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY]
  )
  return {
    descriptor: descriptor.success ? descriptor.data : null,
    incarnationId: status.runtimeId
  }
}

export function clearRuntimeWorkspacePathSearchCapabilityCacheForTests(): void {
  capabilityCache.clear()
  pairingRevisionByEnvironment.clear()
}
