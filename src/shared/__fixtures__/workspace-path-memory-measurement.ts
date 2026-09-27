import { performance } from 'node:perf_hooks'

export const ESTIMATED_RETAINED_BYTES_PER_PATH_OVERHEAD = 48
export const WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024
export const WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024
export const WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES = 480 * 1024 * 1024

export type ProcessMemorySample = {
  elapsedMilliseconds: number
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

export type BuildPeakMemoryMeasurement<T> = {
  value: T
  samples: readonly ProcessMemorySample[]
  baseline: ProcessMemorySample
  peakRssBytes: number
  peakHeapUsedBytes: number
  peakExternalBytes: number
  durationMilliseconds: number
}

/** Mirrors quick-open-path-inventory's deliberately approximate string-retention estimator. */
export function estimateRetainedPathCatalogBytes(paths: Iterable<string>): number {
  let bytes = 0
  for (const path of paths) {
    bytes += path.length * 2 + ESTIMATED_RETAINED_BYTES_PER_PATH_OVERHEAD
  }
  return bytes
}

export function sampleProcessMemoryUsage(): ProcessMemorySample {
  const memory = process.memoryUsage()
  return {
    elapsedMilliseconds: performance.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers
  }
}

/**
 * Samples the Node process while an async build yields to the event loop. Synchronous builds only
 * contribute their start/end samples; use async batches when measuring transient build peaks.
 */
function maxSampleValue(
  samples: readonly ProcessMemorySample[],
  key: 'rssBytes' | 'heapUsedBytes' | 'externalBytes'
): number {
  return samples.reduce((maximum, entry) => Math.max(maximum, entry[key]), 0)
}

export async function measureBuildPeakMemory<T>(
  build: () => T | Promise<T>,
  sampleIntervalMilliseconds = 10
): Promise<BuildPeakMemoryMeasurement<T>> {
  if (!Number.isFinite(sampleIntervalMilliseconds) || sampleIntervalMilliseconds <= 0) {
    throw new RangeError('Memory sample interval must be a positive number of milliseconds')
  }

  const startedAt = performance.now()
  const samples: ProcessMemorySample[] = []
  const sample = (): void => {
    const memory = process.memoryUsage()
    samples.push({
      elapsedMilliseconds: performance.now() - startedAt,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers
    })
  }

  sample()
  const baseline = samples[0]!
  const timer = setInterval(sample, sampleIntervalMilliseconds)
  try {
    const value = await build()
    sample()
    return {
      value,
      samples,
      baseline,
      peakRssBytes: maxSampleValue(samples, 'rssBytes'),
      peakHeapUsedBytes: maxSampleValue(samples, 'heapUsedBytes'),
      peakExternalBytes: maxSampleValue(samples, 'externalBytes'),
      durationMilliseconds: performance.now() - startedAt
    }
  } finally {
    clearInterval(timer)
  }
}
