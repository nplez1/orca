import type { AppState } from '../types'
import { getEnvironmentSshStateGeneration } from '../slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../slices/runtime-status'

export type LocalRepoCatalogFetchOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }

/**
 * Why two generations: a reconnect or a replaced SSH state can land while a catalog fetch is in
 * flight, and a catalog fetched on the old connection must not overwrite the new one's.
 */
export type RuntimeRepoCatalogConnectionFence = {
  environmentId: string
  sshStateGeneration: number
  runtimeConnectionGeneration: number
}

export const latestLocalRepoCatalogFetchByStore = new WeakMap<
  () => AppState,
  Promise<LocalRepoCatalogFetchOutcome>
>()

export const latestRepoCatalogGenerationByHostByStore = new WeakMap<
  () => AppState,
  Map<string, number>
>()

export const latestAllHostRepoCatalogGenerationByStore = new WeakMap<() => AppState, number>()

export function captureRuntimeRepoCatalogConnectionFence(
  environmentId: string
): RuntimeRepoCatalogConnectionFence {
  return {
    environmentId,
    sshStateGeneration: getEnvironmentSshStateGeneration(environmentId),
    runtimeConnectionGeneration: getRuntimeEnvironmentConnectionGeneration(environmentId)
  }
}

export function isRuntimeRepoCatalogConnectionFenceCurrent(
  fence: RuntimeRepoCatalogConnectionFence
): boolean {
  return (
    getEnvironmentSshStateGeneration(fence.environmentId) === fence.sshStateGeneration &&
    getRuntimeEnvironmentConnectionGeneration(fence.environmentId) ===
      fence.runtimeConnectionGeneration
  )
}

export function startLocalRepoCatalogFetch(
  get: () => AppState
): (outcome: LocalRepoCatalogFetchOutcome) => void {
  let settle: (outcome: LocalRepoCatalogFetchOutcome) => void = () => undefined
  const settlement = new Promise<LocalRepoCatalogFetchOutcome>((resolve) => {
    settle = resolve
  })
  latestLocalRepoCatalogFetchByStore.set(get, settlement)
  return settle
}

export async function awaitLatestLocalRepoCatalogFetch(get: () => AppState): Promise<void> {
  while (true) {
    const pending = latestLocalRepoCatalogFetchByStore.get(get)
    if (!pending) {
      return
    }
    const outcome = await pending
    if (latestLocalRepoCatalogFetchByStore.get(get) === pending) {
      if (outcome.status === 'rejected') {
        throw outcome.reason
      }
      return
    }
  }
}

export function claimRepoCatalogGeneration(
  get: () => AppState,
  hostId: string,
  generation: number
): void {
  let generations = latestRepoCatalogGenerationByHostByStore.get(get)
  if (!generations) {
    generations = new Map()
    latestRepoCatalogGenerationByHostByStore.set(get, generations)
  }
  if ((generations.get(hostId) ?? 0) < generation) {
    generations.set(hostId, generation)
  }
}

export function isLatestRepoCatalogGeneration(
  get: () => AppState,
  hostId: string,
  generation: number
): boolean {
  return latestRepoCatalogGenerationByHostByStore.get(get)?.get(hostId) === generation
}
