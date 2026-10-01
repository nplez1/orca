# Workspace path-index performance matrix

## Measurement conditions

- Baseline: Apple M4 Pro, 12 logical CPUs (darwin/arm64); Node v26.0.0.
- Build mode: vitest-node-worker-thread; deterministic seed 1346720326.
- Default admission budgets: 256 MiB/root and 512 MiB/host; warm-query builds used an isolated 4096 MiB budget to measure the index path beyond default admission.
- Warm trials: 5 below 1M and 3 at 1M; p95 uses nearest-rank. Raw timings and memory samples are in the JSON reports.
- Artifacts contain fixture IDs, query-class labels, and numeric observations only; no workspace paths or query strings.

## Warm service/worker verdicts

Latency is the full `WorkspacePathIndexService.search` round trip, including scheduler, worker request/response clone, query, count, bounded page retention, and returned serialized-byte accounting. Strategy was `ordered-scan`; candidates and verifications equal the paths considered for every query class.

| Query class               | 100,000 paths                                               | 300,000 paths                                                  | 500,000 paths                                                  | 1,000,000 paths                                                  |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| broad-one-character       | R 47.9 ms MISS (+22.9 over)<br>A 110.0 ms MISS (+85.0 over) | R 136.2 ms MISS (+111.2 over)<br>A 316.9 ms MISS (+291.9 over) | R 239.4 ms MISS (+214.4 over)<br>A 538.1 ms MISS (+513.1 over) | R 489.6 ms MISS (+429.6 over)<br>A 1063.3 ms MISS (+1003.3 over) |
| no-match                  | R 40.2 ms MISS (+15.2 over)<br>A 106.6 ms MISS (+81.6 over) | R 133.5 ms MISS (+108.5 over)<br>A 319.4 ms MISS (+294.4 over) | R 230.4 ms MISS (+205.4 over)<br>A 533.6 ms MISS (+508.6 over) | R 475.1 ms MISS (+415.1 over)<br>A 1074.1 ms MISS (+1014.1 over) |
| selective-three-character | R 44.9 ms MISS (+19.9 over)<br>A 114.1 ms MISS (+89.1 over) | R 144.2 ms MISS (+119.2 over)<br>A 329.4 ms MISS (+304.4 over) | R 248.3 ms MISS (+223.3 over)<br>A 547.7 ms MISS (+522.7 over) | R 520.3 ms MISS (+460.3 over)<br>A 1096.1 ms MISS (+1036.1 over) |
| multi-token-and           | R 53.6 ms MISS (+28.6 over)<br>A 112.9 ms MISS (+87.9 over) | R 143.1 ms MISS (+118.1 over)<br>A 326.9 ms MISS (+301.9 over) | R 242.8 ms MISS (+217.8 over)<br>A 538.5 ms MISS (+513.5 over) | R 506.8 ms MISS (+446.8 over)<br>A 1078.6 ms MISS (+1018.6 over) |
| long-path                 | R 39.2 ms MISS (+14.2 over)<br>A 108.2 ms MISS (+83.2 over) | R 131.5 ms MISS (+106.5 over)<br>A 324.4 ms MISS (+299.4 over) | R 225.2 ms MISS (+200.2 over)<br>A 541.6 ms MISS (+516.6 over) | R 476.9 ms MISS (+416.9 over)<br>A 1113.3 ms MISS (+1053.3 over) |
| unicode                   | R 36.1 ms MISS (+11.1 over)<br>A 103.5 ms MISS (+78.5 over) | R 132.7 ms MISS (+107.7 over)<br>A 306.4 ms MISS (+281.4 over) | R 224.1 ms MISS (+199.1 over)<br>A 512.6 ms MISS (+487.6 over) | R 481.8 ms MISS (+421.8 over)<br>A 1047.3 ms MISS (+987.3 over)  |
| extension-fragment        | R 44.1 ms MISS (+19.1 over)<br>A 109.1 ms MISS (+84.1 over) | R 137.8 ms MISS (+112.8 over)<br>A 324.3 ms MISS (+299.3 over) | R 237.5 ms MISS (+212.5 over)<br>A 536.1 ms MISS (+511.1 over) | R 488.6 ms MISS (+428.6 over)<br>A 1075.1 ms MISS (+1015.1 over) |
| directory-fragment        | R 45.9 ms MISS (+20.9 over)<br>A 108.9 ms MISS (+83.9 over) | R 139.4 ms MISS (+114.4 over)<br>A 322.0 ms MISS (+297.0 over) | R 237.0 ms MISS (+212.0 over)<br>A 542.9 ms MISS (+517.9 over) | R 494.2 ms MISS (+434.2 over)<br>A 1070.7 ms MISS (+1010.7 over) |
| slash-spanning-fragment   | R 40.5 ms MISS (+15.5 over)<br>A 110.7 ms MISS (+85.7 over) | R 134.5 ms MISS (+109.5 over)<br>A 326.3 ms MISS (+301.3 over) | R 241.9 ms MISS (+216.9 over)<br>A 542.1 ms MISS (+517.1 over) | R 487.8 ms MISS (+427.8 over)<br>A 1087.1 ms MISS (+1027.1 over) |

Target: ≤25 ms p95 at 100k–500k and ≤60 ms p95 at 1M. Every measured query-class/profile/size cell misses. The exact class-by-class values, p50/max, candidate counts, matches, retained rows, serialized bytes, and raw samples are in the JSON matrix.

## Cold synthetic worker builds

| Profile                   | Catalog paths | First scope (ms) | All scopes (ms) | Stream throughput (paths/s) | Retained bytes | RSS baseline / peak / delta (MiB) | Host heap peak (MiB) | Host external peak (MiB) | Worker heap peak / delta (MiB) | Worker external peak (MiB) | Main event-loop max (ms) |
| ------------------------- | ------------: | ---------------: | --------------: | --------------------------: | -------------: | --------------------------------: | -------------------: | -----------------------: | -----------------------------: | -------------------------: | -----------------------: |
| realistic-shared-prefixes |       100,000 |            561.3 |           778.0 |                      257060 |       16214327 |             72.9 / 195.9 / +123.0 |                 23.8 |                      2.6 |                   44.0 / +38.1 |                       18.3 |                     12.6 |
| realistic-shared-prefixes |       300,000 |           1878.3 |          2585.7 |                      232041 |       48985143 |            371.2 / 472.3 / +101.1 |                 33.9 |                      2.9 |                 124.6 / +118.9 |                       51.3 |                     14.4 |
| realistic-shared-prefixes |       500,000 |           3268.2 |          4510.2 |                      221717 |       81752440 |            417.6 / 519.9 / +102.3 |                 34.1 |                      2.9 |                 161.1 / +155.7 |                       81.4 |                     13.0 |
| realistic-shared-prefixes |     1,000,000 |           6809.5 |          9414.6 |                      212436 |      163685945 |            412.5 / 843.3 / +430.9 |                 31.5 |                      2.9 |                 279.9 / +274.1 |                      159.6 |                     22.3 |
| adversarial-long-unshared |       100,000 |            683.9 |          1068.0 |                      187264 |       62667104 |             568.0 / 631.8 / +63.8 |                 24.7 |                      3.3 |                   97.3 / +89.8 |                       67.0 |                     12.1 |
| adversarial-long-unshared |       300,000 |           2413.7 |          3695.9 |                      162339 |      188017104 |            576.8 / 816.2 / +239.4 |                 31.2 |                      4.0 |                 228.3 / +221.4 |                      186.7 |                     12.6 |
| adversarial-long-unshared |       500,000 |           3838.7 |          6100.1 |                      163931 |      313367104 |           728.7 / 1106.8 / +378.1 |                 42.4 |                      5.5 |                 387.0 / +380.9 |                      306.5 |                     12.8 |
| adversarial-long-unshared |     1,000,000 |           8181.9 |         12912.2 |                      154892 |      626742104 |          824.8 / 1874.1 / +1049.3 |                 43.1 |                      5.5 |                 673.9 / +667.0 |                      605.6 |                     12.8 |

These are generated, two-scope streams through the real worker build lane; they are not filesystem discovery timings. Build sort stages ran in the worker. `retainedBytes` is per-root catalog retention; RSS is process-wide, so the baseline and per-build delta are shown alongside absolute peak, while heap/external are sampled separately in the host and worker isolates. Old-plus-replacement generation coexistence was not measured.

## Real filesystem discovery

A deterministic 100k-file tree was scanned with ripgrep and streamed into the worker: 442.2 ms first-scope-ready, 600.7 ms all-scopes-ready, 332785 paths/s over both passes, 275.0 MiB process peak RSS (+104.2 MiB over baseline), 39.0 MiB worker heap peak (+33.9 MiB), and 12.6 ms event-loop-delay maximum. Worker sort stage: 214.3 ms; no seconds-long main-thread sort was observed. The raw memory samples are in the discovery JSON.

## Default admission boundary

| Profile                   | Largest admitted catalog | Indexed paths | First rejected catalog | Degradation | Peak RSS delta at admitted probe (MiB) |
| ------------------------- | -----------------------: | ------------: | ---------------------: | ----------- | -------------------------------------: |
| realistic-shared-prefixes |                   436000 |        436000 |                 437000 | over-budget |                                   27.2 |
| adversarial-long-unshared |                   145000 |        145000 |                 146000 | over-budget |                                   65.9 |

The default service refuses the 1M reservation of 517371700 bytes (493.4 MiB) before starting discovery; this is over the 256 MiB root reservation cap but below the 512 MiB host cap. A lower reservation recovers. The secondary per-path estimator predicts an eligible-record reservation boundary of realistic-shared-prefixes: 436792; adversarial-long-unshared: 145111. That estimator is not a substitute for the measured end-to-end service boundary.

## Churn and renderer

At 100k, create/delete/rename publication took 0.6 / 0.2 / 0.2 ms; the next query took 45.9 / 45.0 / 43.3 ms. A 100-event explicit batch published in 1.2 ms; a query during that batch took 45.5 ms. A 10k-delta compaction workload took 668.7 ms. The producer-side watcher coalescer was not exercised.

| Renderer fixture                | Projection p95 (ms) | Virtual commit p95 (ms) | 16 ms verdict                |
| ------------------------------- | ------------------: | ----------------------: | ---------------------------- |
| shallow-5000-leaves             |                 9.2 |                     7.1 | projection pass; commit pass |
| ancestor-heavy-deep-5000-leaves |                47.0 |                     2.5 | projection miss; commit pass |
| byte-limited-page               |                 3.5 |                     0.8 | projection pass; commit pass |

Renderer numbers use Phase 4 timing hooks and React DOM commits of 100 virtual rows in happy-dom because jsdom is not installed. They are not native layout/compositor/paint timings. The ancestor-heavy 5k-leaf projection misses 16 ms; shallow and byte-limited projections pass.

## Input-to-paint and Phase 6–7 decision inputs

- Input-to-paint: unmeasured. No hidden-renderer CDP session was available with the required `$electron` skill in this environment; no paint number is inferred or fabricated. Host round-trip, projection, and virtual commit were measured separately and are not summed because they came from independent runs.
- Phase 6 query acceleration: needed for the 1M target. Every size/profile/class misses; selective/no-match, multi-token, long-path, Unicode, extension/directory, and slash-spanning queries scan the complete candidate set and are trigram-addressable. One-character broad scans are not trigram-addressable and also miss; postings cannot remove their O(N) cost.
- Phase 6 compact/spill: needed to meet the 1M scale floor under 256 MiB/root. Default service admission stops at the measured profile-specific boundaries above, below 1M. The 1M reservation is refused; retain a visible fallback until compact/spill is measured.
- Phase 7 checkpointing: measure a prototype before deciding to implement. Cold synthetic all-scope rebuilds cost 9415 ms realistic and 12912 ms adversarial; the real 100k filesystem build is 600.7 ms. Checkpoint load plus reconciliation/revisit latency is not implemented or measured, so rebuild cost alone does not establish net benefit.

## Re-run

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-path-index/workspace-path-index-service-matrix.test.ts
ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_DISCOVERY_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-path-index/workspace-path-index-discovery-matrix.test.ts
ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_PROJECTION_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/file-explorer-name-filter-projection-matrix.test.ts
node config/scripts/workspace-path-index-report.mjs
```

Warm matrix supports `ORCA_PATH_INDEX_MATRIX_MAX_SIZE=100000` for a quick harness smoke run; omit it for the full 100k/300k/500k/1M campaign.
