export type WorkspacePathSortCancellation = {
  isCancelled(): boolean
}

const SORT_YIELD_MILLISECONDS = 8
const SORT_CHECK_INTERVAL = 256

export async function stableSortWorkspacePathIds(
  values: Uint32Array,
  compare: (left: number, right: number) => number,
  cancellation?: WorkspacePathSortCancellation
): Promise<Uint32Array> {
  let source: Uint32Array<ArrayBufferLike> = values
  let target: Uint32Array<ArrayBufferLike> = new Uint32Array(values.length)
  let operations = 0
  let lastYieldAt = performance.now()
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length)
      const end = Math.min(start + width * 2, values.length)
      let left = start
      let right = middle
      let output = start
      while (left < middle || right < end) {
        if (
          right >= end ||
          (left < middle && compare(source[left] ?? 0, source[right] ?? 0) <= 0)
        ) {
          target[output] = source[left] ?? 0
          left += 1
        } else {
          target[output] = source[right] ?? 0
          right += 1
        }
        output += 1
        operations += 1
        await maybeYield()
      }
    }
    const previous = source
    source = target
    target = previous
  }
  return source

  async function maybeYield(): Promise<void> {
    if (operations % SORT_CHECK_INTERVAL !== 0) {
      return
    }
    throwIfCancelled(cancellation)
    if (performance.now() - lastYieldAt < SORT_YIELD_MILLISECONDS) {
      return
    }
    await yieldWorkerTurn()
    lastYieldAt = performance.now()
    throwIfCancelled(cancellation)
  }
}

export async function stableSortWorkspacePathValues<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  cancellation?: WorkspacePathSortCancellation
): Promise<T[]> {
  let source = [...values]
  let target = [...values]
  let operations = 0
  let lastYieldAt = performance.now()
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length)
      const end = Math.min(start + width * 2, source.length)
      let left = start
      let right = middle
      let output = start
      while (left < middle || right < end) {
        const leftValue = source[left]
        const rightValue = source[right]
        if (
          right >= end ||
          (left < middle &&
            leftValue !== undefined &&
            rightValue !== undefined &&
            compare(leftValue, rightValue) <= 0)
        ) {
          if (leftValue !== undefined) {
            target[output] = leftValue
          }
          left += 1
        } else {
          if (rightValue !== undefined) {
            target[output] = rightValue
          }
          right += 1
        }
        output += 1
        operations += 1
        await maybeYield()
      }
    }
    const previous = source
    source = target
    target = previous
  }
  return source

  async function maybeYield(): Promise<void> {
    if (operations % SORT_CHECK_INTERVAL !== 0) {
      return
    }
    throwIfCancelled(cancellation)
    if (performance.now() - lastYieldAt < SORT_YIELD_MILLISECONDS) {
      return
    }
    await yieldWorkerTurn()
    lastYieldAt = performance.now()
    throwIfCancelled(cancellation)
  }
}

function throwIfCancelled(cancellation: WorkspacePathSortCancellation | undefined): void {
  if (cancellation?.isCancelled()) {
    throw new Error('Workspace path catalog build was cancelled')
  }
}

function yieldWorkerTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
