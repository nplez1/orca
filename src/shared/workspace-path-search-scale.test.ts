import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  generateWorkspacePathCatalog,
  WORKSPACE_PATH_CATALOG_SIZES,
  type WorkspacePathCatalogShape
} from './__fixtures__/workspace-path-catalog'
import { measureBuildPeakMemory } from './__fixtures__/workspace-path-memory-measurement'
import { runWorkspacePathSearchQueryBattery } from './__fixtures__/workspace-path-search-query-battery'

const runScaleSuite = process.env.ORCA_RUN_PATH_SEARCH_SCALE === '1'
const runFullMillionBattery = process.env.ORCA_RUN_PATH_SEARCH_SCALE_BATTERY === '1'
const CATALOG_SHAPES: readonly WorkspacePathCatalogShape[] = [
  'realistic-shared-prefixes',
  'adversarial-long-unshared'
]

describe.skipIf(!runScaleSuite)('workspace path-search scale fixtures', () => {
  it.each(WORKSPACE_PATH_CATALOG_SIZES)(
    'streams %i paths from both deterministic catalog shapes',
    async (size) => {
      for (const shape of CATALOG_SHAPES) {
        const measurement = await measureBuildPeakMemory(() => consumeCatalog(size, shape), 20)
        expect(measurement.value.count).toBe(size)
        expect(measurement.value.checksum).toBeGreaterThan(0)
        console.info(
          `[path-search-scale] shape=${shape} size=${size} generationMs=${measurement.durationMilliseconds.toFixed(1)} peakRssMiB=${(measurement.peakRssBytes / 1024 / 1024).toFixed(1)} peakHeapMiB=${(measurement.peakHeapUsedBytes / 1024 / 1024).toFixed(1)}`
        )
      }
    },
    120_000
  )
})

describe.skipIf(!runScaleSuite || !runFullMillionBattery)(
  'workspace path-search 1M correctness battery',
  () => {
    it.each(CATALOG_SHAPES)(
      'matches every battery query for the 1M %s catalog',
      (shape) => {
        const startedAt = performance.now()
        const rows = runWorkspacePathSearchQueryBattery(() =>
          generateWorkspacePathCatalog({ size: 1_000_000, shape, seed: 0x50455246 })
        )
        expect(rows.length).toBeGreaterThan(0)
        console.info(
          `[path-search-scale] shape=${shape} fullBatteryQueries=${rows.length} durationMs=${(performance.now() - startedAt).toFixed(1)}`
        )
      },
      900_000
    )
  }
)

async function consumeCatalog(
  size: number,
  shape: WorkspacePathCatalogShape
): Promise<{ count: number; checksum: number }> {
  let count = 0
  let checksum = 0
  for (const path of generateWorkspacePathCatalog({ size, shape, seed: 0x50455246 })) {
    checksum =
      (checksum * 33 + path.length + path.charCodeAt(0) + path.charCodeAt(path.length - 1)) >>> 0
    count += 1
    if (count % 20_000 === 0) {
      await yieldToEventLoop()
    }
  }
  return { count, checksum }
}
