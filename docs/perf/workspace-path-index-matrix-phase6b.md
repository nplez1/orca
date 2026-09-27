# Workspace path-index Phase 6b measurements

## Scope

Phase 6b is the plan §8 row 6 exit: "greater admitted capacity within budget; exact oracle parity
retained" (compact/spilled catalog). This page records the admitted capacity, the reservation split,
the resident-vs-spilled warm cost, the decode optimization, and the parity evidence. The raw numeric
samples are in [`workspace-path-index-matrix-phase6b.json`](./workspace-path-index-matrix-phase6b.json);
the resident 100k block-representation prototype is in
[`workspace-path-catalog-blocks-phase6b.json`](./workspace-path-catalog-blocks-phase6b.json); the
previous baseline is [`workspace-path-index-matrix-phase6a.json`](./workspace-path-index-matrix-phase6a.json).
The implemented disk format is specified in
[`workspace-path-catalog-block-format.md`](../reference/workspace-path-catalog-block-format.md).

## Conditions

Apple M4 Pro, 12 logical CPUs, 51.5 GiB RAM, Node v26.0.0, darwin/arm64, build mode
`vitest-node-worker-thread`. Same deterministic fixtures, seed, query battery, scope matrix, and
nearest-rank p95 definition as the Phase 6a matrix. Warm samples: 5 below 1M, 3 at 1M. Memory
sampled every 10 ms. Default budgets are the shipped 256 MiB root / 512 MiB host caps with a 480 MiB
host build-peak reservation; the `residentOrSpillModeQueries` table below is a separate 4 GiB
warm-build-budget campaign kept only to measure the resident fast path at 1M. Do not compare the two
budget modes as if they were one number. Raw samples contain numeric counts, durations, and memory
only — no paths, query text, or workspace identifiers.

This campaign was measured with the block checksum implemented as a 256-entry table (see below). That
change is decode/verify-only and format-preserving; the raw samples here are the shipped-code numbers.

## Admitted capacity and host reserves (the exit row)

Before Phase 6b, the builder reservation for a resident 1M catalog was 517,371,700 B (493.4 MiB),
which exceeds the 256 MiB root cap, so the default service refused 1M entirely. Phase 6b replaces
that single all-in-RAM reservation with a 256 MiB root retained reservation plus a 480 MiB host
build-peak reservation, and spills the catalog to checksummed blocks.

| Profile                   | Default-budget admitted before (6a) | First refused before | Default-budget admitted after (6b) | Storage after  | Retained typed arrays |    Spill file |
| ------------------------- | ----------------------------------: | -------------------: | ---------------------------------: | -------------- | --------------------: | ------------: |
| Realistic shared-prefixes |                             436,000 |              437,000 |                    1,000,000 (2/2) | `disk-spilled` |          15,097,416 B |  75,176,835 B |
| Adversarial long/unshared |                             145,000 |              146,000 |                    1,000,000 (2/2) | `disk-spilled` |          15,097,416 B | 593,509,839 B |

The Phase 6a boundary is reported only as context (an estimator-derived static boundary now reads
436,792 realistic / 145,111 adversarial). The 6b boundary is the 1M scale floor proven by two
complete default-budget service builds per profile plus an exact worker query; no path-count
estimator is treated as admission.

| Reservation / peak          |   Before (6a model) |                            After (6b model) |
| --------------------------- | ------------------: | ------------------------------------------: |
| Root retained reservation   |             256 MiB |                                     256 MiB |
| Host budget                 |             512 MiB |                                     512 MiB |
| Host build-peak reservation |       none declared |                                     480 MiB |
| 1M builder reservation      | 493.4 MiB (refused) | root 256 MiB + host peak 480 MiB (admitted) |

Measured 1M spill build RSS deltas, two default-budget runs per profile:

| Profile                   | Run 0 peak RSS delta | Run 1 peak RSS delta | All scopes ready |
| ------------------------- | -------------------: | -------------------: | ---------------: |
| Realistic shared-prefixes |            253.2 MiB |            233.0 MiB |  45.3 s / 45.0 s |
| Adversarial long-unshared |            324.3 MiB |            280.0 MiB |  64.3 s / 64.4 s |

The worst observed spill build delta (324.3 MiB) fits the 480 MiB host build-peak reservation with
headroom; the retained typed arrays stay at 15.1 MB, far below the 256 MiB root cap. Run-to-run RSS
variance is real (233–324 MiB), so the reservation is a measured ceiling, not a prediction. It must be
re-probed on other hardware and under multi-root/multiple-Orca-process pressure before being treated
as fixed.

## Default-budget build outcomes

Whether the service keeps the resident fast path or spills is a function of size and profile. At
100k–300k realistic and 100k adversarial the catalog stays `packed-folded` with postings; from
300k adversarial and 500k realistic it spills and postings are absent (dropped before coverage).

| Profile     | Paths | Mode            |     Retained |     Postings |    Spill file |  Build | Peak RSS delta |
| ----------- | ----: | --------------- | -----------: | -----------: | ------------: | -----: | -------------: |
| Realistic   |  100k | `packed-folded` | 21,721,972 B |  5,507,645 B |             — |  2.6 s |      159.0 MiB |
| Realistic   |  300k | `packed-folded` | 64,203,569 B | 15,218,426 B |             — |  8.8 s |      155.5 MiB |
| Realistic   |  500k | `disk-spilled`  |  8,597,416 B |            0 |  37,580,771 B | 22.5 s |      145.9 MiB |
| Realistic   |    1M | `disk-spilled`  | 15,097,416 B |            0 |  75,176,835 B | 45.3 s |      238.4 MiB |
| Adversarial |  100k | `packed-folded` | 72,126,551 B |  9,459,447 B |             — |  4.8 s |      166.3 MiB |
| Adversarial |  300k | `disk-spilled`  |  5,997,416 B |            0 | 178,057,529 B | 20.4 s |       64.4 MiB |
| Adversarial |  500k | `disk-spilled`  |  8,597,416 B |            0 | 296,753,518 B | 32.3 s |      283.1 MiB |
| Adversarial |    1M | `disk-spilled`  | 15,097,416 B |            0 | 593,509,839 B | 64.3 s |      263.9 MiB |

## Warm p95: resident mode, 6a → 6b (packed-folded, 4 GiB warm-build campaign)

Milliseconds, nearest-rank p95. Targets are ≤25 ms through 500k and ≤60 ms at 1M. This table isolates
the resident fast path from the spill trade-off; it is the same budget mode as the Phase 6a baseline.
The prefix-block CRC change does not touch the `packed-folded` path, so these cells are baseline
tracking plus run-to-run noise.

| Paths | Profile     | Query class               | 6a p95 | 6b p95 | Verdict |
| ----: | ----------- | ------------------------- | -----: | -----: | ------- |
|  100k | Realistic   | broad-one-character       |   17.9 |   18.1 | pass    |
|  100k | Realistic   | no-match                  |    0.2 |    0.2 | pass    |
|  100k | Realistic   | selective-three-character |    7.7 |    6.7 | pass    |
|  100k | Realistic   | multi-token-and           |    7.7 |    7.6 | pass    |
|  100k | Realistic   | long-path                 |    0.1 |    0.1 | pass    |
|  100k | Realistic   | unicode                   |    0.1 |    0.1 | pass    |
|  100k | Realistic   | extension-fragment        |    9.1 |    6.1 | pass    |
|  100k | Realistic   | directory-fragment        |    4.7 |    4.6 | pass    |
|  100k | Realistic   | slash-spanning-fragment   |    0.4 |    0.4 | pass    |
|  300k | Realistic   | broad-one-character       |   54.9 |   49.9 | miss    |
|  300k | Realistic   | no-match                  |    0.2 |    0.2 | pass    |
|  300k | Realistic   | selective-three-character |   22.8 |   17.7 | pass    |
|  300k | Realistic   | multi-token-and           |   18.6 |   22.1 | pass    |
|  300k | Realistic   | long-path                 |    0.1 |    0.1 | pass    |
|  300k | Realistic   | unicode                   |    0.1 |    0.1 | pass    |
|  300k | Realistic   | extension-fragment        |   19.9 |   14.4 | pass    |
|  300k | Realistic   | directory-fragment        |   10.2 |    9.3 | pass    |
|  300k | Realistic   | slash-spanning-fragment   |    1.1 |    1.2 | pass    |
|  500k | Realistic   | broad-one-character       |   90.4 |   88.6 | miss    |
|  500k | Realistic   | no-match                  |    0.2 |    0.2 | pass    |
|  500k | Realistic   | selective-three-character |   36.5 |   29.2 | miss    |
|  500k | Realistic   | multi-token-and           |   37.0 |   34.1 | miss    |
|  500k | Realistic   | long-path                 |    0.1 |    0.1 | pass    |
|  500k | Realistic   | unicode                   |    0.1 |    0.1 | pass    |
|  500k | Realistic   | extension-fragment        |   34.2 |   34.9 | miss    |
|  500k | Realistic   | directory-fragment        |   23.6 |   21.5 | pass    |
|  500k | Realistic   | slash-spanning-fragment   |    1.9 |    1.8 | pass    |
|    1M | Realistic   | broad-one-character       |  198.9 |  183.9 | miss    |
|    1M | Realistic   | no-match                  |    0.1 |    0.1 | pass    |
|    1M | Realistic   | selective-three-character |   70.2 |   65.9 | miss    |
|    1M | Realistic   | multi-token-and           |   70.9 |   69.1 | miss    |
|    1M | Realistic   | long-path                 |    0.2 |    0.1 | pass    |
|    1M | Realistic   | unicode                   |    0.1 |    0.1 | pass    |
|    1M | Realistic   | extension-fragment        |   73.0 |   67.9 | miss    |
|    1M | Realistic   | directory-fragment        |   54.1 |   42.2 | pass    |
|    1M | Realistic   | slash-spanning-fragment   |    4.0 |    3.4 | pass    |
|  100k | Adversarial | broad-one-character       |   15.2 |   16.5 | pass    |
|  100k | Adversarial | no-match                  |    0.1 |    0.1 | pass    |
|  100k | Adversarial | selective-three-character |   22.7 |   23.4 | pass    |
|  100k | Adversarial | multi-token-and           |   19.1 |   14.5 | pass    |
|  100k | Adversarial | long-path                 |   24.9 |   23.0 | pass    |
|  100k | Adversarial | unicode                   |    0.1 |    0.1 | pass    |
|  100k | Adversarial | extension-fragment        |   21.6 |   22.7 | pass    |
|  100k | Adversarial | directory-fragment        |   11.2 |   11.1 | pass    |
|  100k | Adversarial | slash-spanning-fragment   |   14.7 |   14.6 | pass    |
|  300k | Adversarial | broad-one-character       |   34.5 |   34.3 | miss    |
|  300k | Adversarial | no-match                  |    0.1 |    0.1 | pass    |
|  300k | Adversarial | selective-three-character |   62.4 |   63.4 | miss    |
|  300k | Adversarial | multi-token-and           |   33.6 |   36.3 | miss    |
|  300k | Adversarial | long-path                 |   69.4 |   77.7 | miss    |
|  300k | Adversarial | unicode                   |    0.1 |    0.1 | pass    |
|  300k | Adversarial | extension-fragment        |   57.8 |   65.3 | miss    |
|  300k | Adversarial | directory-fragment        |   29.6 |   32.5 | miss    |
|  300k | Adversarial | slash-spanning-fragment   |   37.1 |   41.3 | miss    |
|  500k | Adversarial | broad-one-character       |   52.0 |   52.8 | miss    |
|  500k | Adversarial | no-match                  |    0.1 |    0.1 | pass    |
|  500k | Adversarial | selective-three-character |   96.5 |  100.0 | miss    |
|  500k | Adversarial | multi-token-and           |   56.0 |   56.7 | miss    |
|  500k | Adversarial | long-path                 |  122.3 |  114.4 | miss    |
|  500k | Adversarial | unicode                   |    0.2 |    0.1 | pass    |
|  500k | Adversarial | extension-fragment        |   91.8 |   93.7 | miss    |
|  500k | Adversarial | directory-fragment        |   48.1 |   48.8 | miss    |
|  500k | Adversarial | slash-spanning-fragment   |   74.8 |   60.7 | miss    |
|    1M | Adversarial | broad-one-character       |   98.5 |   95.1 | miss    |
|    1M | Adversarial | no-match                  |    0.1 |    0.1 | pass    |
|    1M | Adversarial | selective-three-character |  227.1 |  217.4 | miss    |
|    1M | Adversarial | multi-token-and           |  106.3 |  111.3 | miss    |
|    1M | Adversarial | long-path                 |  260.7 |  229.9 | miss    |
|    1M | Adversarial | unicode                   |    0.2 |    0.2 | pass    |
|    1M | Adversarial | extension-fragment        |  197.1 |  180.7 | miss    |
|    1M | Adversarial | directory-fragment        |   96.1 |   92.7 | miss    |
|    1M | Adversarial | slash-spanning-fragment   |  123.1 |  121.4 | miss    |

Resident `packed-folded` warm p95 is unchanged within run noise from the Phase 6a baseline. The
remaining misses are the same scan-bound cells Phase 6a already reported; spill did not regress the
resident path.

## Warm p95: default-budget mode, resident vs spilled

At the default budgets the service keeps the resident path only while it fits. Once it spills, a
query is an exact O(N) block scan: it reads the whole file, so every query class costs about the same
and no longer benefits from postings. Milliseconds, nearest-rank p95; `R` = `packed-folded` resident,
`S` = `disk-spilled`. Columns are broad, no-match, selective, multi-token, long-path, unicode,
extension, directory, slash-spanning.

| Profile     | Paths | Mode |  broad | no-match | selective | multi-token | long-path | unicode | extension | directory | slash-spanning |
| ----------- | ----: | ---- | -----: | -------: | --------: | ----------: | --------: | ------: | --------: | --------: | -------------: |
| Realistic   |  100k | R    |   16.1 |      0.1 |       6.6 |         6.7 |       0.1 |     0.1 |       6.2 |       4.6 |            0.5 |
| Realistic   |  300k | R    |   49.3 |      0.1 |      17.5 |        27.1 |       0.1 |     0.1 |      14.4 |       9.8 |            1.2 |
| Realistic   |  500k | S    |  252.1 |    248.1 |     262.7 |       259.8 |     245.7 |   245.0 |     255.5 |     255.5 |          250.7 |
| Realistic   |    1M | S    |  500.2 |    489.9 |     522.1 |       517.3 |     489.4 |   483.3 |     507.9 |     509.8 |          504.7 |
| Adversarial |  100k | R    |   20.7 |      0.1 |      24.8 |        13.3 |      27.5 |     0.1 |      24.8 |      10.7 |           15.3 |
| Adversarial |  300k | S    |  720.1 |    714.8 |     727.5 |       722.7 |     727.8 |   722.2 |     715.4 |     713.9 |          721.5 |
| Adversarial |  500k | S    | 1205.6 |   1209.4 |    1231.8 |      1210.9 |    1223.4 |  1191.6 |    1204.4 |    1200.5 |         1223.2 |
| Adversarial |    1M | S    | 2396.1 |   2384.6 |    2422.1 |      2400.0 |    2408.7 |  2357.8 |    2369.6 |    2365.6 |         2392.7 |

This is the honest cost of the capacity gain. A 1M default-budget catalog is admitted, but while it
is spilled a warm query is ~0.5 s realistic and ~2.4 s adversarial, and the flat per-class cost shows
the scan is decode-bound rather than match-bound. Spilled mode is explicitly lower-performance and is
chosen only after resident admission fails; the alternative for these sizes under the shipped budgets
is the complete live scan, which is slower and walks the filesystem. Selective queries are not faster
than broad ones in spilled mode — there is no candidate reduction on disk. The 100k resident
prototype result (33.0% realistic / 2.3% adversarial byte savings at 116/414 ms broad p95) is why the
prefix form is not used resident; see
[`workspace-path-catalog-blocks-phase6b.md`](./workspace-path-catalog-blocks-phase6b.md).

## Measured decode optimization

The block checksum was the dominant cost of a spilled scan. It was a bit-at-a-time loop (eight
iterations per byte) over every block payload, so one 1M adversarial query validated roughly 0.6 GB
with ~4.7 billion inner steps. Moving it to a 256-entry table
([`workspace-path-catalog-block-checksum.ts`](../../src/shared/workspace-path-catalog-block-checksum.ts))
produces identical CRC-32 values and does not change the on-disk format.

| Measure (1M adversarial, direct spilled scan) |   Before |    After | Change |
| --------------------------------------------- | -------: | -------: | -----: |
| Read + decode every block, no matching        | 8,221 ms | 2,282 ms |   3.6× |
| Full exact query                              | 9,488 ms | 2,714 ms |   3.5× |

The same change shows up end-to-end in the service p95 above: adversarial 1M broad fell from 8,232 ms
to 2,396 ms and realistic 1M broad from 1,041 ms to 500 ms; adversarial 1M builds fell from 146.2 s
to 64.3 s. This is a decode/verify win, not a storage redesign; block size, block bounds, run layout,
and the 256-path/131,072-code-unit/512 KiB limits are unchanged.

## Spilled query mechanics

At 1M every spilled query reported `strategy: disk-block-scan`, `spillBlocksRead: 3907`,
`pathsConsidered/candidates/verifications: 1,000,000`, and `decodedBlockCacheHits: 0`. Read bytes
track the file: ~51.1 MB per realistic broad query and ~569.5 MB per adversarial broad query. The
3907 blocks are the 1M paths at the 256-path block bound. Zero cache hits is structural, not a
measured miss — the disk reader decodes each block once and never consults the resident decoded-block
LRU (the 2 MiB LRU is for resident `prefix-compressed` random access). Do not read it as a warm
cache.

## Parity evidence

Correctness is the non-negotiable part of the exit row (plan §3 coverage/honesty, §4.6 degradation
order): spilled mode may be slower, never less correct.

- `workspace-path-catalog-spill-runs.test.ts` — both generator profiles × full query battery × 16
  scope descriptors against the straightforward oracle, with cross-scope dedupe, classification, and
  `compareFileNames` natural-ordering checks; build runs and the final spill both compared.
- `workspace-path-catalog-spill.test.ts` — header/identity round-trip, checksum and truncation
  rejection, write cancellation, bounded disk budget, stale-process cleanup, generation
  eviction/root disposal, exact disk-query answers, mid-block cancellation, and byte-bounded page
  retention parity against the oracle in spilled mode.
- `workspace-path-catalog-spill-scale.test.ts` (opt-in, `ORCA_RUN_PATH_SEARCH_SCALE=1`) — the full
  battery × 16 scope descriptors × both profiles at 1M in spilled mode against the oracle, asserting
  identical retained page, exact total count, and ordering. **Result: 2/2 passed, 1,545 s.** Oracle
  and query share one page budget (`maxPaths: 5,000`, `maxSerializedBytes: 1,000,000`); without the
  byte budget on both sides the adversarial long-path profile retains fewer rows than the oracle
  expects.

Mid-generation spilling publishes the first READY scope as a complete generation before the second
scope finishes, so a query never sees a partial generation; the complete generation publishes once
after the second scope. Corruption fails the query closed (rebuild/live-scan), never a successful
empty result.
