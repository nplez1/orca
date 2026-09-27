import { describe, expect, it } from 'vitest'
import { WorkspacePathIndexBuildLane } from './workspace-path-index-build-lane'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

describe('WorkspacePathIndexBuildLane', () => {
  it('runs one build at a time and prioritizes active workspaces', async () => {
    const first = deferred<string>()
    const order: string[] = []
    const lane = new WorkspacePathIndexBuildLane(3)
    const backgroundController = new AbortController()
    const activeController = new AbortController()
    const firstBuild = lane.run({
      signal: new AbortController().signal,
      activeWorkspace: false,
      run: async () => {
        order.push('first')
        return first.promise
      }
    })
    const background = lane.run({
      signal: backgroundController.signal,
      activeWorkspace: false,
      run: async () => {
        order.push('background')
        return 'background'
      }
    })
    const active = lane.run({
      signal: activeController.signal,
      activeWorkspace: true,
      run: async () => {
        order.push('active')
        return 'active'
      }
    })
    first.resolve('first')
    await expect(firstBuild).resolves.toBe('first')
    await expect(active).resolves.toBe('active')
    await expect(background).resolves.toBe('background')
    expect(order).toEqual(['first', 'active', 'background'])
    lane.dispose()
  })

  it('bounds queued builds and cancels work before dispatch', async () => {
    const running = deferred<string>()
    const lane = new WorkspacePathIndexBuildLane(1)
    const first = lane.run({
      signal: new AbortController().signal,
      activeWorkspace: true,
      run: () => running.promise
    })
    const queuedController = new AbortController()
    const queued = lane.run({
      signal: queuedController.signal,
      activeWorkspace: false,
      run: async () => 'queued'
    })
    const overflow = lane.run({
      signal: new AbortController().signal,
      activeWorkspace: false,
      run: async () => 'overflow'
    })
    await expect(overflow).rejects.toThrow('lane is full')
    queuedController.abort()
    await expect(queued).rejects.toThrow('cancelled')
    running.resolve('done')
    await expect(first).resolves.toBe('done')
    lane.dispose()
  })
})
