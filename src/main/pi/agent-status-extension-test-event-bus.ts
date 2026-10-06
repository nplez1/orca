import type { EventEmitter } from 'node:events'

/** The object a Pi registration reads as `pi.events`. */
export type PiEventBus = {
  on: (name: string, listener: (event: unknown) => void) => unknown
  off?: (name: string, listener: (event: unknown) => void) => unknown
}

type BusSubscription = [string, (event: unknown) => void]

/** What Pi hands a registration as `pi.events`: an object over the session's emitter that records
 *  every subscription the registration makes, so the harness can drop exactly those when Pi
 *  replaces it, and releases a channel the same way an extension's own shutdown does. */
export function createTrackedPiEventBus(
  emitter: EventEmitter,
  subscriptions: BusSubscription[]
): PiEventBus {
  return {
    on(name: string, listener: (event: unknown) => void) {
      emitter.on(name, listener)
      subscriptions.push([name, listener])
    },
    off(name: string, listener: (event: unknown) => void) {
      emitter.off(name, listener)
      for (let index = subscriptions.length - 1; index >= 0; index--) {
        const [entryName, entryListener] = subscriptions[index]
        if (entryName === name && entryListener === listener) {
          subscriptions.splice(index, 1)
        }
      }
    }
  }
}
