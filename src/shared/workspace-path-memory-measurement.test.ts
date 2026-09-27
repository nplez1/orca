import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  estimateRetainedPathCatalogBytes,
  ESTIMATED_RETAINED_BYTES_PER_PATH_OVERHEAD,
  measureBuildPeakMemory,
  sampleProcessMemoryUsage,
  WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from './__fixtures__/workspace-path-memory-measurement'

describe('workspace path memory measurement', () => {
  it('uses the inventory estimator formula for UTF-16 code-unit lengths', () => {
    expect(ESTIMATED_RETAINED_BYTES_PER_PATH_OVERHEAD).toBe(48)
    expect(estimateRetainedPathCatalogBytes(['a', '𐐀'])).toBe(102)
    expect(estimateRetainedPathCatalogBytes(new Set(['one', 'two']))).toBe(108)
    expect(estimateRetainedPathCatalogBytes([])).toBe(0)
  })

  it('exposes the proposed root and host memory budgets', () => {
    expect(WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES).toBe(256 * 1024 * 1024)
    expect(WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES).toBe(512 * 1024 * 1024)
  })

  it('samples RSS and heap while an asynchronous build yields', async () => {
    const measurement = await measureBuildPeakMemory(async () => {
      await delay(8)
      return 'built'
    }, 1)
    const directSample = sampleProcessMemoryUsage()

    expect(measurement.value).toBe('built')
    expect(measurement.samples.length).toBeGreaterThan(1)
    expect(measurement.baseline.rssBytes).toBeGreaterThan(0)
    expect(measurement.peakRssBytes).toBeGreaterThanOrEqual(measurement.baseline.rssBytes)
    expect(measurement.peakHeapUsedBytes).toBeGreaterThan(0)
    expect(measurement.durationMilliseconds).toBeGreaterThan(0)
    expect(directSample.heapUsedBytes).toBeGreaterThan(0)
  })

  it('rejects a non-positive sampling interval', async () => {
    await expect(measureBuildPeakMemory(() => 'built', 0)).rejects.toThrow(RangeError)
  })
})
