/**
 * Which paired hosts this machine is connected to right now.
 *
 * Why main keeps its own answer: the renderer's connection slice is not readable here, and the
 * alternative — asking every peer during a status read — would make an adjacency build cost a round
 * trip per host. This is fed by the one seam the main already has for connection diagnostics.
 */

const connected = new Map<string, number>()

export type HostGraphConnectionObservation = {
  environmentId: string
  transportGeneration: number
  state: 'closed' | 'awaiting_ready' | 'awaiting_authenticated' | 'ready' | 'reconnecting'
}

export function observeHostGraphEnvironmentConnection(
  observation: HostGraphConnectionObservation
): void {
  if (observation.state !== 'ready') {
    connected.delete(observation.environmentId)
    return
  }
  connected.set(observation.environmentId, observation.transportGeneration)
}

export function connectedHostGraphEnvironmentIds(): ReadonlySet<string> {
  return new Set(connected.keys())
}

/** Test seam only: a process starts with no connections observed. */
export function resetHostGraphConnectionState(): void {
  connected.clear()
}
