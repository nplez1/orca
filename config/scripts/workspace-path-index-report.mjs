import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDirectory = join(process.cwd(), 'docs', 'perf')
const matrix = await readJson('workspace-path-index-matrix.json')
const discovery = await readJson('workspace-path-index-discovery.json')
const renderer = await readJson('workspace-path-index-renderer-matrix.json')
const output = join(outputDirectory, 'workspace-path-index-matrix.md')
const sizes = matrix.metadata.selectedSizes
const shapes = ['realistic-shared-prefixes', 'adversarial-long-unshared']
const queryClasses = matrix.matrix[0]?.queries.map((query) => query.queryClass) ?? []
const lines = [
  '# Workspace path-index performance matrix',
  '',
  '## Measurement conditions',
  '',
  `- Baseline: ${matrix.metadata.cpuModel}, ${matrix.metadata.logicalCpuCount} logical CPUs (${matrix.metadata.platform}/${matrix.metadata.architecture}); Node ${matrix.metadata.nodeVersion}.`,
  `- Build mode: ${matrix.metadata.buildMode}; deterministic seed ${matrix.matrix[0]?.seed ?? 'unavailable'}.`,
  `- Default admission budgets: ${(matrix.metadata.defaultRootBudgetBytes / 1_048_576).toFixed(0)} MiB/root and ${(matrix.metadata.defaultHostBudgetBytes / 1_048_576).toFixed(0)} MiB/host; warm-query builds used an isolated ${(matrix.metadata.experimentalWarmBuildBudgetBytes / 1_048_576).toFixed(0)} MiB budget to measure the index path beyond default admission.`,
  `- Warm trials: ${matrix.metadata.warmRunCountBelowOneMillion} below 1M and ${matrix.metadata.warmRunCountAtOneMillion} at 1M; p95 uses nearest-rank. Raw timings and memory samples are in the JSON reports.`,
  '- Artifacts contain fixture IDs, query-class labels, and numeric observations only; no workspace paths or query strings.',
  '',
  '## Warm service/worker verdicts',
  '',
  'Latency is the full `WorkspacePathIndexService.search` round trip, including scheduler, worker request/response clone, query, count, bounded page retention, and returned serialized-byte accounting. Strategy was `ordered-scan`; candidates and verifications equal the paths considered for every query class.',
  '',
  `| Query class | ${sizes.map((size) => `${size.toLocaleString()} paths`).join(' | ')} |`,
  `| --- | ${sizes.map(() => '---').join(' | ')} |`
]

for (const queryClass of queryClasses) {
  const cells = sizes.map((size) => {
    const rows = shapes.map((shape) => {
      const fixture = matrix.matrix.find((entry) => entry.size === size && entry.shape === shape)
      const result = fixture?.queries.find((query) => query.queryClass === queryClass)
      const verdict = String(result?.verdict ?? 'unmeasured').toUpperCase()
      const excess =
        typeof result?.overTargetMilliseconds === 'number'
          ? ` (+${format(result.overTargetMilliseconds)} over)`
          : ''
      return `${shape === shapes[0] ? 'R' : 'A'} ${format(result?.p95Milliseconds)} ms ${verdict}${excess}`
    })
    return rows.join('<br>')
  })
  lines.push(`| ${queryClass} | ${cells.join(' | ')} |`)
}

lines.push(
  '',
  'Target: ≤25 ms p95 at 100k–500k and ≤60 ms p95 at 1M. Every measured query-class/profile/size cell misses. The exact class-by-class values, p50/max, candidate counts, matches, retained rows, serialized bytes, and raw samples are in the JSON matrix.',
  '',
  '## Cold synthetic worker builds',
  '',
  '| Profile | Catalog paths | First scope (ms) | All scopes (ms) | Stream throughput (paths/s) | Retained bytes | RSS baseline / peak / delta (MiB) | Host heap peak (MiB) | Host external peak (MiB) | Worker heap peak / delta (MiB) | Worker external peak (MiB) | Main event-loop max (ms) |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
)
for (const fixture of matrix.matrix) {
  lines.push(
    `| ${fixture.shape} | ${fixture.size.toLocaleString()} | ${format(fixture.build?.firstScopeReadyMilliseconds)} | ${format(fixture.build?.allScopesReadyMilliseconds)} | ${format(fixture.build?.generatedPathsPerSecond, 0)} | ${format(fixture.build?.retainedBytes, 0)} | ${formatMiB(fixture.build?.memorySamples?.[0]?.rssBytes)} / ${formatMiB(fixture.build?.peakRssBytes)} / +${formatMiB(fixture.build?.peakRssDeltaBytes)} | ${formatMiB(fixture.build?.peakHostHeapUsedBytes)} | ${formatMiB(fixture.build?.peakHostExternalBytes)} | ${formatMiB(fixture.build?.peakWorkerHeapUsedBytes)} / +${formatMiB(fixture.build?.peakWorkerHeapUsedDeltaBytes)} | ${formatMiB(fixture.build?.peakWorkerExternalBytes)} | ${format(fixture.build?.eventLoopDelayMaximumMilliseconds)} |`
  )
}
lines.push(
  '',
  'These are generated, two-scope streams through the real worker build lane; they are not filesystem discovery timings. Build sort stages ran in the worker. `retainedBytes` is per-root catalog retention; RSS is process-wide, so the baseline and per-build delta are shown alongside absolute peak, while heap/external are sampled separately in the host and worker isolates. Old-plus-replacement generation coexistence was not measured.',
  '',
  '## Real filesystem discovery',
  '',
  `A deterministic 100k-file tree was scanned with ripgrep and streamed into the worker: ${format(discovery.firstScopeReadyMilliseconds)} ms first-scope-ready, ${format(discovery.allScopesReadyMilliseconds)} ms all-scopes-ready, ${format(discovery.pathsPerSecondThroughAllPasses, 0)} paths/s over both passes, ${formatMiB(discovery.peakRssBytes)} MiB process peak RSS (+${formatMiB(discovery.peakRssDeltaBytes)} MiB over baseline), ${formatMiB(discovery.workerPeakHeapUsedBytes)} MiB worker heap peak (+${formatMiB(discovery.workerPeakHeapUsedDeltaBytes)} MiB), and ${format(discovery.eventLoopDelayMaximumMilliseconds)} ms event-loop-delay maximum. Worker sort stage: ${format(maxValue(discovery.workerStageTimings.map((stage) => stage.milliseconds)))} ms; no seconds-long main-thread sort was observed. The raw memory samples are in the discovery JSON.`,
  '',
  '## Default admission boundary',
  '',
  '| Profile | Largest admitted catalog | Indexed paths | First rejected catalog | Degradation | Peak RSS delta at admitted probe (MiB) |',
  '| --- | ---: | ---: | ---: | --- | ---: |'
)
for (const boundary of matrix.admission.verifiedServiceBoundary) {
  const admitted = boundary.probes
    .filter((probe) => probe.admitted)
    .sort((left, right) => right.requestedPathCount - left.requestedPathCount)[0]
  lines.push(
    `| ${boundary.fixtureId} | ${format(admitted?.requestedPathCount, 0)} | ${format(admitted?.indexedPathCount, 0)} | ${format(boundary.firstRejectedRequestedPathCount, 0)} | over-budget | ${formatMiB(admitted?.peakRssDeltaBytes)} |`
  )
}
lines.push(
  '',
  `The default service refuses the 1M reservation of ${format(matrix.admission.knownOneMillionReservationBytes, 0)} bytes (${format(matrix.admission.knownOneMillionReservationMiB)} MiB) before starting discovery; this is over the 256 MiB root reservation cap but below the 512 MiB host cap. A lower reservation recovers. The secondary per-path estimator predicts an eligible-record reservation boundary of ${matrix.admission.boundaries.map((entry) => `${entry.fixtureId}: ${format(entry.maximumEligibleCatalogPathCountByBuilderReservation, 0)}`).join('; ')}. That estimator is not a substitute for the measured end-to-end service boundary.`,
  '',
  '## Churn and renderer',
  '',
  `At 100k, create/delete/rename publication took ${format(matrix.churn.create.publishMilliseconds)} / ${format(matrix.churn.delete.publishMilliseconds)} / ${format(matrix.churn.rename.publishMilliseconds)} ms; the next query took ${format(matrix.churn.create.nextQuery.milliseconds)} / ${format(matrix.churn.delete.nextQuery.milliseconds)} / ${format(matrix.churn.rename.nextQuery.milliseconds)} ms. A 100-event explicit batch published in ${format(matrix.churn.storm.publishMilliseconds)} ms; a query during that batch took ${format(matrix.churn.storm.queryDuringChurn.milliseconds)} ms. A 10k-delta compaction workload took ${format(matrix.churn.compaction.publishMilliseconds)} ms. The producer-side watcher coalescer was not exercised.`,
  '',
  '| Renderer fixture | Projection p95 (ms) | Virtual commit p95 (ms) | 16 ms verdict |',
  '| --- | ---: | ---: | --- |'
)
for (const testCase of renderer.cases) {
  lines.push(
    `| ${testCase.fixtureId} | ${format(testCase.projection.p95Milliseconds)} | ${format(testCase.virtualPageCommit.p95Milliseconds)} | projection ${testCase.projectionP95Verdict}; commit ${testCase.commitP95Verdict} |`
  )
}
lines.push(
  '',
  'Renderer numbers use Phase 4 timing hooks and React DOM commits of 100 virtual rows in happy-dom because jsdom is not installed. They are not native layout/compositor/paint timings. The ancestor-heavy 5k-leaf projection misses 16 ms; shallow and byte-limited projections pass.',
  '',
  '## Input-to-paint and Phase 6–7 decision inputs',
  '',
  '- Input-to-paint: unmeasured. No hidden-renderer CDP session was available with the required `$electron` skill in this environment; no paint number is inferred or fabricated. Host round-trip, projection, and virtual commit were measured separately and are not summed because they came from independent runs.',
  '- Phase 6 query acceleration: needed for the 1M target. Every size/profile/class misses; selective/no-match, multi-token, long-path, Unicode, extension/directory, and slash-spanning queries scan the complete candidate set and are trigram-addressable. One-character broad scans are not trigram-addressable and also miss; postings cannot remove their O(N) cost.',
  '- Phase 6 compact/spill: needed to meet the 1M scale floor under 256 MiB/root. Default service admission stops at the measured profile-specific boundaries above, below 1M. The 1M reservation is refused; retain a visible fallback until compact/spill is measured.',
  `- Phase 7 checkpointing: measure a prototype before deciding to implement. Cold synthetic all-scope rebuilds cost ${formatBuildAt(matrix, 1_000_000, shapes[0])} ms realistic and ${formatBuildAt(matrix, 1_000_000, shapes[1])} ms adversarial; the real 100k filesystem build is ${format(discovery.allScopesReadyMilliseconds)} ms. Checkpoint load plus reconciliation/revisit latency is not implemented or measured, so rebuild cost alone does not establish net benefit.`,
  '',
  '## Re-run',
  '',
  '```sh',
  'ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-path-index/workspace-path-index-service-matrix.test.ts',
  'ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_DISCOVERY_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-path-index/workspace-path-index-discovery-matrix.test.ts',
  'ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_PROJECTION_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/file-explorer-name-filter-projection-matrix.test.ts',
  'node config/scripts/workspace-path-index-report.mjs',
  '```',
  '',
  'Warm matrix supports `ORCA_PATH_INDEX_MATRIX_MAX_SIZE=100000` for a quick harness smoke run; omit it for the full 100k/300k/500k/1M campaign.'
)

await writeFile(output, `${lines.join('\n')}\n`)
console.info('Wrote the path-index matrix summary.')

async function readJson(fileName) {
  return JSON.parse(await readFile(join(outputDirectory, fileName), 'utf8'))
}

function format(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function formatMiB(value) {
  return typeof value === 'number' && Number.isFinite(value) ? (value / 1_048_576).toFixed(1) : '—'
}

function maxValue(values) {
  return values.length > 0 ? Math.max(...values) : null
}

function formatBuildAt(report, size, shape) {
  const fixture = report.matrix.find((entry) => entry.size === size && entry.shape === shape)
  return format(fixture?.build?.allScopesReadyMilliseconds, 0)
}
