import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import { removeWorkspacePathCatalogSpill } from './workspace-path-catalog-spill'

const MAX_RETAINED_GENERATIONS_PER_ROOT = 2

export function workspacePathIndexWorkerGenerationKey(
  rootKey: string,
  generationId: string
): string {
  return `${rootKey}\u0000${generationId}`
}

export function publishWorkspacePathIndexWorkerGeneration(args: {
  generations: Map<string, WorkspacePathCatalogGeneration>
  latestGenerationIds: Map<string, string>
  rootKey: string
  generationId: string
  generation: WorkspacePathCatalogGeneration
}): void {
  const generationKey = workspacePathIndexWorkerGenerationKey(args.rootKey, args.generationId)
  args.generations.set(generationKey, args.generation)
  args.latestGenerationIds.set(args.rootKey, args.generationId)
  const ownedKeys = [...args.generations.keys()].filter((key) =>
    key.startsWith(`${args.rootKey}\u0000`)
  )
  while (ownedKeys.length > MAX_RETAINED_GENERATIONS_PER_ROOT) {
    const oldestKey = ownedKeys.shift()
    if (oldestKey) {
      const evicted = args.generations.get(oldestKey)
      args.generations.delete(oldestKey)
      const evictedSpill = evicted?.catalog.storageKind === 'disk-spilled' ? evicted.catalog : null
      if (
        evictedSpill &&
        ![...args.generations.values()].some(
          (generation) =>
            generation.catalog.storageKind === 'disk-spilled' &&
            generation.catalog.spillFilePath === evictedSpill.spillFilePath
        )
      ) {
        void removeWorkspacePathCatalogSpill(evictedSpill).catch(() => undefined)
      }
    }
  }
}

/** Removes one generation without disturbing the root's other retained generations. */
export function dropWorkspacePathIndexWorkerGeneration(args: {
  generations: Map<string, WorkspacePathCatalogGeneration>
  latestGenerationIds: Map<string, string>
  rootKey: string
  generationId: string
}): void {
  const generationKey = workspacePathIndexWorkerGenerationKey(args.rootKey, args.generationId)
  const generation = args.generations.get(generationKey)
  args.generations.delete(generationKey)
  if (args.latestGenerationIds.get(args.rootKey) === args.generationId) {
    args.latestGenerationIds.delete(args.rootKey)
  }
  if (generation?.catalog.storageKind !== 'disk-spilled') {
    return
  }
  const spillFilePath = generation.catalog.spillFilePath
  const spillStillShared = [...args.generations.values()].some(
    (candidate) =>
      candidate.catalog.storageKind === 'disk-spilled' &&
      candidate.catalog.spillFilePath === spillFilePath
  )
  if (!spillStillShared) {
    void removeWorkspacePathCatalogSpill(generation.catalog).catch(() => undefined)
  }
}

export function dropWorkspacePathIndexWorkerRoot(args: {
  generations: Map<string, WorkspacePathCatalogGeneration>
  latestGenerationIds: Map<string, string>
  rootKey: string
}): void {
  const prefix = `${args.rootKey}\u0000`
  const spilledCatalogs = new Map<string, WorkspacePathCatalogGeneration['catalog']>()
  for (const [key, generation] of args.generations) {
    if (key.startsWith(prefix)) {
      args.generations.delete(key)
      if (generation.catalog.storageKind === 'disk-spilled') {
        spilledCatalogs.set(generation.catalog.spillFilePath, generation.catalog)
      }
    }
  }
  for (const catalog of spilledCatalogs.values()) {
    void removeWorkspacePathCatalogSpill(catalog).catch(() => undefined)
  }
  args.latestGenerationIds.delete(args.rootKey)
}
