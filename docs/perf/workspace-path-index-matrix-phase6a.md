# Workspace path-index Phase 6a measurements

## Conditions

Same deterministic worker-service matrix, fixtures, query classes, seed, machine, and build mode as [`workspace-path-index-matrix.md`](workspace-path-index-matrix.md): Apple M4 Pro, 12 logical CPUs, Node v26.0.0, darwin/arm64; 5 warm samples below 1M and 3 at 1M; nearest-rank p95. Full raw samples, per-query stage timings, exact counts, candidate counts, retained bytes, and memory samples are in [`workspace-path-index-matrix-phase6a.json`](workspace-path-index-matrix-phase6a.json). No baseline artifact was overwritten. The matrix intentionally uses the existing isolated 4 GiB warm-build budget to exercise 1M queries; it is not evidence that every fixture is admitted by the normal 256 MiB root build reservation.

## Service-path decomposition

Durations are p95 milliseconds for realistic-profile requests. `worker-extra` is worker round trip minus worker query-strategy time (queueing, message cloning/transfer, and reply handling); service scheduling is the residual after ensure and worker round trip. These are distinct host-local monotonic measurements.

| Size / class  | Before: service / worker query / gap | After: ensure / query / worker RTT / worker-extra / service residual |
| ------------- | -----------------------------------: | -------------------------------------------------------------------: |
| 300k broad    |               136.21 / 134.78 / 1.50 |                                   0.01 / 53.43 / 54.92 / 1.49 / 0.02 |
| 300k no-match |               133.53 / 133.34 / 0.19 |                                     0.01 / 0.08 / 0.14 / 0.06 / 0.01 |
| 1M broad      |               489.60 / 488.12 / 1.49 |                                 0.01 / 197.41 / 198.82 / 1.54 / 0.02 |
| 1M selective  |               520.30 / 518.84 / 1.46 |                                   0.02 / 68.76 / 70.18 / 1.56 / 0.02 |
| 1M no-match   |               475.06 / 474.91 / 0.16 |                                     0.01 / 0.07 / 0.12 / 0.05 / 0.01 |

The “2–3× service overhead” was not in the same execution stage: service samples already showed only ~0.2–1.5 ms beyond the in-worker query. The separate raw-catalog benchmark used `folded-strings` (300k broad/no-match p95 49.48/43.91 ms), while the service worker used `packed-folded` and reconstructed a new JS string per path (service 136.21/133.53 ms). Direct packed-code-unit matching removes that allocation-heavy scan; remaining 1M broad work is still scan-bound. Serialization/transport is a small constant, about 1.5 ms on page-bearing requests; exact JSON-byte accounting remains in query-strategy time.

## Warm service p95 (baseline → Phase 6a, milliseconds)

| Paths | Query class               | Realistic shared-prefixes | Adversarial long/unshared |
| ----: | ------------------------- | ------------------------: | ------------------------: |
|  100k | broad-one-character       |               47.9 → 17.9 |              110.0 → 15.2 |
|  100k | no-match                  |                40.2 → 0.2 |               106.6 → 0.1 |
|  100k | selective-three-character |                44.9 → 7.7 |              114.1 → 22.7 |
|  100k | multi-token-and           |                53.6 → 7.7 |              112.9 → 19.1 |
|  100k | long-path                 |                39.2 → 0.1 |              108.2 → 24.9 |
|  100k | unicode                   |                36.1 → 0.1 |               103.5 → 0.1 |
|  100k | extension-fragment        |                44.1 → 9.1 |              109.1 → 21.6 |
|  100k | directory-fragment        |                45.9 → 4.7 |              108.9 → 11.2 |
|  100k | slash-spanning-fragment   |                40.5 → 0.4 |              110.7 → 14.7 |
|  300k | broad-one-character       |              136.2 → 54.9 |              316.9 → 34.5 |
|  300k | no-match                  |               133.5 → 0.2 |               319.4 → 0.1 |
|  300k | selective-three-character |              144.2 → 22.8 |              329.4 → 62.4 |
|  300k | multi-token-and           |              143.1 → 18.6 |              326.9 → 33.6 |
|  300k | long-path                 |               131.5 → 0.1 |              324.4 → 69.4 |
|  300k | unicode                   |               132.7 → 0.1 |               306.4 → 0.1 |
|  300k | extension-fragment        |              137.8 → 19.9 |              324.3 → 57.8 |
|  300k | directory-fragment        |              139.4 → 10.2 |              322.0 → 29.6 |
|  300k | slash-spanning-fragment   |               134.5 → 1.1 |              326.3 → 37.1 |
|  500k | broad-one-character       |              239.4 → 90.4 |              538.1 → 52.0 |
|  500k | no-match                  |               230.4 → 0.2 |               533.6 → 0.1 |
|  500k | selective-three-character |              248.3 → 36.5 |              547.7 → 96.5 |
|  500k | multi-token-and           |              242.8 → 37.0 |              538.5 → 56.0 |
|  500k | long-path                 |               225.2 → 0.1 |             541.6 → 122.3 |
|  500k | unicode                   |               224.1 → 0.1 |               512.6 → 0.2 |
|  500k | extension-fragment        |              237.5 → 34.2 |              536.1 → 91.8 |
|  500k | directory-fragment        |              237.0 → 23.6 |              542.9 → 48.1 |
|  500k | slash-spanning-fragment   |               241.9 → 1.9 |              542.1 → 74.8 |
|    1M | broad-one-character       |             489.6 → 198.9 |             1063.3 → 98.5 |
|    1M | no-match                  |               475.1 → 0.1 |              1074.1 → 0.1 |
|    1M | selective-three-character |              520.3 → 70.2 |            1096.1 → 227.1 |
|    1M | multi-token-and           |              506.8 → 70.9 |            1078.6 → 106.3 |
|    1M | long-path                 |               476.9 → 0.2 |            1113.3 → 260.7 |
|    1M | unicode                   |               481.8 → 0.1 |              1047.3 → 0.2 |
|    1M | extension-fragment        |              488.6 → 73.0 |            1075.1 → 197.1 |
|    1M | directory-fragment        |              494.2 → 54.1 |             1070.7 → 96.1 |
|    1M | slash-spanning-fragment   |               487.8 → 4.0 |            1087.1 → 123.1 |

Targets are ≤25 ms through 500k and ≤60 ms at 1M. All 100k cells pass. At 300k, realistic broad alone misses (54.9 ms); adversarial no-match/unicode pass, its other classes miss. At 500k, realistic broad/selective/multi-token/extension miss; adversarial no-match/unicode pass, its other classes miss. At 1M, realistic no-match/long-path/unicode/directory/slash-spanning meet target; adversarial only no-match/unicode meet target. Remaining misses are scans or large candidate sets: realistic 1M broad is 198.9 ms (3.3× target), selective 70.2 ms; adversarial selective query terms match most paths and correctly fall back to ordered scan.

## Retained memory and strategy

| Profile / paths    | Catalog + postings (MiB) | Postings (MiB) | Build peak RSS (MiB) |
| ------------------ | -----------------------: | -------------: | -------------------: |
| Realistic / 100k   |                     20.7 |            5.3 |                241.5 |
| Realistic / 300k   |                     61.2 |           14.5 |                501.8 |
| Realistic / 500k   |                    101.8 |           23.8 |                592.9 |
| Realistic / 1M     |                    203.2 |           47.1 |                970.7 |
| Adversarial / 100k |                     68.8 |            9.0 |                980.0 |
| Adversarial / 300k |                    205.1 |           25.8 |                851.2 |
| Adversarial / 500k |                    341.5 |           42.6 |               1238.8 |
| Adversarial / 1M   |                    682.4 |           84.6 |               2139.2 |

The realistic 1M retained catalog plus postings is below the 256 MiB steady-state root cap, but its estimated 493.4 MiB build reservation exceeds normal root admission, so ordinary service admission still refuses it. Adversarial retained storage exceeds 256 MiB from 500k. Peak RSS is process-wide, not per-root retained memory.

Postings are a sorted numeric 3×UTF-16-code-unit dictionary plus per-gram counts/offsets and delta-varint natural-order ranks in typed arrays. A three-pass build keeps scratch proportional to unique gram count; incomplete/over-budget builds publish no accelerator. Complete base postings are intersected rarest-first; a 50%-of-scope heuristic scans broad lists, including one-character and repeated-gram queries. Every base candidate still runs the exact token predicate. Delta paths are always scanned and merged in natural order; compaction rebuilds postings. Base tombstones/replacements are checked after candidate selection. No matching-ID cache was added.

## Reproduction

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_RUN_PATH_INDEX_MATRIX=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-path-index/workspace-path-index-service-matrix.test.ts
```
