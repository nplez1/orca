import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool.ts'

// Perf contracts: the only tests allowed to count work (docs/agents-md-refs/test-antipatterns.md#perf-contracts).
const contractGlobs = [
  'src/**/*.performance.test.{ts,tsx,mjs}',
  'config/scripts/**/*.performance.test.{ts,tsx,mjs}',
  'tests/tools/**/*.performance.test.{ts,tsx,mjs}'
]
// LOCAL(nplez1): fork-owned perf contracts. They are not named *.performance.test.*, so the globs
// above miss them, and they get no work-count exception.
const namedContracts = [
  'src/shared/workspace-path-search-performance-contract.test.ts',
  'src/main/workspace-path-index/workspace-path-index-performance-contract.test.ts',
  'src/main/workspace-path-index/workspace-path-index-build-lane.test.ts',
  'src/main/workspace-path-index/workspace-path-index-admission-scheduler.test.ts'
]
for (const contract of namedContracts) {
  if (!existsSync(resolve(contract))) {
    throw new Error(`Missing performance contract: ${contract}`)
  }
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Project-level includes otherwise override this contract-only selection.
    projects: undefined,
    ...(process.versions.bun ? { pool: 'node-runtime', poolRunner: nodeRuntimePool } : {}),
    include: [...contractGlobs, ...namedContracts],
    // Upstream ships no contract of its own yet; keep the job green until the first one lands.
    passWithNoTests: true,
    benchmark: { include: [] },
    retry: 0
  }
})
