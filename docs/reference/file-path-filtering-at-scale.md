# File-path filtering at scale

The Explore name filter is a strict path search; Quick Open (Cmd+P) is a separate fuzzy path
search. Both return bounded pages, but only a complete host-side scan or a complete, fresh index
snapshot can support an exact empty result.

## Search contract

- Explore matching is whitespace-tokenized, locale-lowercased substring-AND over normalized
  relative paths. A match in a directory segment also matches its descendants. It is not fuzzy,
  basename-only, regex, or content search.
- Quick Open keeps its fuzzy `QuickOpenPathRanker`; changing the name-filter rollout switch does
  not change Quick Open matching or ranking.
- Name-filter pages are ordered with `compareFileNames`. The host counts every match and retains
  only a bounded page (normally at most 5,000 files, further limited by serialized-byte and
  transport budgets). The tree's directory-first sibling order is a separate projection.
- `QUICK_OPEN_LISTING_MAX_RESULTS` remains 20,001 for unscoped listings. It is not a filter scan
  limit and must not be raised to compensate for a missing index.
- A complete scan counts the whole authorized scope; only display retention is bounded. A zero
  count is definitive only when coverage is complete, freshness is `no-known-gap`, and the count
  provenance is `exact-snapshot`. A partial page is never described as “no files match.”

## Execution-host support

Enumeration and matching belong to the host that owns the filesystem. A remote disconnect never
causes a client-local substitute search.

| Host/workspace route                      | Path index                                                     | Name-filter behavior                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local native repository/worktree          | Yes, in the local main-process worker                          | The Files view acquires a lease; a query also ensures initialization. A complete fresh generation answers in memory while it fits the root budget; a catalog too large to hold resident is spilled to a host-local, checksummed, versioned disk representation and scanned exactly in bounded blocks. Missing, stale, unsupported, over-budget-and-unspilled, or corrupt index work falls back to the cancellable full live scan. |
| Local folder workspace                    | Yes, when served through local `fs:searchFilePaths`            | Same authorized-root index and exact live-scan fallback as a local repository; a Git repository is not required for path enumeration.                                                                                                                                                                                                                                                                                             |
| WSL path served by the local Windows host | Yes, using host-side discovery through the WSL-aware scanner   | Index freshness uses WSL-specific validation. The WSL watcher polls only two directory levels, so a deep change is not immediately visible to the watcher. Validation and a live scan are recovery paths; deep-path freshness is a declared limitation, not a guarantee of immediate notification.                                                                                                                                |
| SSH filesystem                            | No client-side index                                           | A negotiated name-filter request is scanned by the SSH execution host's relay. A legacy relay may only provide a bounded listing, which remains partial/unknown rather than an exact empty result.                                                                                                                                                                                                                                |
| Remote runtime host                       | No persistent path catalog in the current runtime search route | `files.searchPaths` runs the bounded scan on that runtime host. Older peers use the existing capability/legacy fallback and preserve partial provenance.                                                                                                                                                                                                                                                                          |
| Remote folder context                     | No local-client index                                          | Uses the execution host's runtime or SSH path above; it is never read from the desktop client as a substitute.                                                                                                                                                                                                                                                                                                                    |

The local index is a name-filter fast path, not a claim that every host has the same index. Quick Open
fuzzy queries remain on their existing search route. Remote work stays owned by the remote
execution host.

## Index lifecycle and snapshot semantics

The local service is keyed by authorized root, host identity, listing-policy version, fold version,
and requested scope. A lease or a name-filter query may start a background build; the query does
not wait for discovery. Ordinary local unscoped listing can also request a warm build. **Opening
Explorer attempts to acquire a lease; it does not promise that discovery has finished before the
first keystroke.** A cold, unavailable, or rebuilding index therefore falls back to live search.

The catalog tracks path-set coverage separately from freshness. Its included/all scopes, dotfile
and ignored-file visibility, exclusions, count, classification flags, and rows belong to one
published generation. Watcher updates are reconciled as bounded deltas; incomplete updates do not
silently become exact empty results. Native watcher-suppressed high-churn directories are
reconciled in the background rather than added to the watcher's event stream.

| Coverage                   | Freshness / count provenance                                             | Meaning and UI rule                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`                 | `no-known-gap` / `exact-snapshot`                                        | Full requested scope is represented and current by the host's freshness rules. Exact count and a definitive empty state are permitted.                                                                      |
| `complete`                 | `dirty`, `reconciling`, or `provisional` / `last-known` or `provisional` | The generation covers the scope, but current membership is uncertain. Its rows/count are only a last-known preview. Local name-filter IPC uses the full live scan instead of treating it as a fresh answer. |
| `partial` or `unavailable` | Any non-authoritative freshness / `provisional`, `sentinel`, or `legacy` | Coverage or authority is insufficient. Do not show “no files match”; use the supported host's live scan, or a partial/unavailable state when no complete scan is available.                                 |
| Any coverage               | `failed`, `disconnected`, or `unknown` / non-exact                       | No authoritative current answer is available. A disconnect is not evidence of process death and never authorizes local fallback.                                                                            |

Native local roots are validated every five minutes with a fifteen-minute freshness deadline; WSL
roots are validated every minute with a two-minute deadline. High-churn scopes receive targeted
reconciliation every minute. If a watcher gap, overflow, failed reconciliation, or freshness
deadline makes the snapshot uncertain, the system downgrades freshness and records the reason.

## Budgets and admission

The index admission defaults are **256 MiB per root** and **512 MiB per host**, including retained
catalogs and build reservations, plus a measured **480 MiB host build-peak reservation**. Reservations
are admitted before allocation; root or host budget refusal does not truncate the index into a false
complete snapshot. These budgets are independent of `QUICK_OPEN_LISTING_MAX_RESULTS`.

A 1M-path root is now admitted under the defaults, but not necessarily resident. Degradation follows
the plan §4.6 order:

1. **Drop optional acceleration.** Incomplete or over-budget trigram postings are discarded before
   abandoning catalog coverage. A missing posting never means “no match.”
2. **Spill a resident catalog to disk.** Before evicting a READY generation for another root, the
   service asks the worker to spill it: version-1 prefix blocks in checksummed build runs merged in
   natural order, published atomically as a host-local `.wpc` file. A spilled generation is still one
   exact generation — same count, page, scope, and ordering as the oracle — but a query is an exact
   O(N) block scan and is much slower (measured ~0.5 s realistic / ~2.4 s adversarial warm p95 at 1M
   vs ~0.1–0.25 s resident). It does not reuse a whole-catalog cache; the 2 MiB decoded-block LRU is
   bounded active decoding for resident prefix blocks only.
3. **Live scan.** If the index cannot be admitted or storage fails, the existing bounded, cancellable
   live scan runs with a visible reason. Corruption and storage exhaustion are rebuild/live-scan
   conditions, never a successful empty result.

Measured capacities, spill file sizes, and the resident-vs-spilled p95 matrix are in
[`workspace-path-index-matrix-phase6b.json`](../perf/workspace-path-index-matrix-phase6b.json) and its
[summary](../perf/workspace-path-index-matrix-phase6b.md); the on-disk format is in
[`workspace-path-catalog-block-format.md`](./workspace-path-catalog-block-format.md). These values are
measurements, not constants; consult the artifacts rather than copying them into this page. The 480
MiB build-peak reservation is a measured bound and must be re-probed on other hardware and under
multi-root pressure.

The warm-query acceptance targets were revised on 2026-09-27 to a measured per-class × per-size
matrix for the host exact-match scan: p95, worst of the realistic and adversarial profiles,
`1.2 ×` measured p95 rounded up to 5 ms, never below the original §2 band floor (25 ms through
500k, 60 ms at 1M). Every other §2 target and the §2 measurement contract still apply.

| Paths | broad-1-char | no-match | selective-3 | multi-token | long-path | unicode | extension | directory | slash |
| ----: | -----------: | -------: | ----------: | ----------: | --------: | ------: | --------: | --------: | ----: |
|  100k |           25 |       25 |          30 |          25 |        30 |      25 |        30 |        25 |    25 |
|  300k |           60 |       25 |          80 |          45 |        95 |      25 |        80 |        40 |    50 |
|  500k |          110 |       25 |         120 |          70 |       140 |      25 |       115 |        60 |    75 |
|    1M |          225 |       60 |         265 |         135 |       280 |      60 |       220 |       115 |   150 |

Closing the remaining gap is follow-up work (typed-array/SIMD broad scanning, worker-parallel
scans); search coverage and exact counts were never traded to reach these numbers.

A refused or over-budget index that cannot spill falls back to the complete live scan on supported
local routes.

## Fallback and feature switch

The internal kill switch follows Orca's established `ORCA_DISABLE_*` environment convention:

```sh
ORCA_DISABLE_WORKSPACE_PATH_INDEX=1
```

When unset, the index is enabled by default in all builds, including internal/development builds. When set to
`1`, local name-filter queries take the complete cancellable live-scan route only: no index ensure,
build/warm, or lease acquisition occurs. Local unscoped listing still works, and Quick Open's
fuzzy matcher is unchanged. Other values do not disable the index. Remote hosts continue to use
their own negotiated search route because the local index switch does not transfer filesystem
authority to the client.

With the switch enabled, an indexed answer is used only when its coverage is complete, freshness
is `no-known-gap`, and its count is exact. Otherwise the local handler uses a complete live scan
when it can. Degradation/cache-miss reasons include `missing`, `building`, `expired`,
`over-budget`, `failed`, `uncovered-scope`, `classification-pending`, `interrupted`,
`disconnected`, `transport-budget`, `unsupported`, and `feature-disabled`; cancellation and
revoked authorization stop rather than launch a substitute scan. Not every reason applies to every
host route. If the live scan itself fails or is cancelled, it does not become a successful empty
answer.

## Development diagnostics and shadow checks

In an unpackaged development host, the main-process summary API is:

```js
await window.api.fs.getWorkspacePathSearchDiagnosticsSummary()
```

It returns numeric aggregate counts for queries served by `ordered-scan`, `trigram-postings`,
`matching-id-bitset`, `disk-block-scan`, `live-scan`, or `legacy-search`; cache-miss and fallback
reasons (including `spill-unavailable`); admission refusals; and freshness downgrades. It contains no paths, query text, workspace identifiers, or
correlation IDs. `window.api.fs.exportWorkspacePathSearchInstrumentation()` retains the bounded
per-event detail (hashed workspace identity, numeric counts/timings, and strategy/reason values).
The renderer timing hook remains available as `window.__orcaWorkspacePathSearchTimings()`.
Diagnostics IPC is rejected in packaged builds; its in-memory records are bounded and reset when
the process restarts.

The fixture-only shadow harness at
[`workspace-path-search-shadow-harness.ts`](../../src/shared/__fixtures__/workspace-path-search-shadow-harness.ts)
compares sampled catalog answers with the straightforward oracle in tests. Its default sample rate
is 1%; `ORCA_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE` configures it for dev/test runs. It is not
imported by production search code. Mismatch diagnostics contain only hashed fixture/query IDs and
numeric counts; they never replace or modify the result returned by the index path.

## Wire compatibility

Remote clients and hosts may be on different versions. Runtime `files.searchPaths` and SSH relay
name-filter requests use existing optional capability negotiation; older peers stay on the
legacy path and must preserve partial/count provenance. No client-local scan is used to cover a
remote disconnect. The matching contract and response state remain conservative for unknown
future values; see [`remote-wire-compatibility.md`](./remote-wire-compatibility.md).

## Verification pointers

The relevant coverage includes local IPC fallback/switch tests, relay and runtime capability tests,
worker/service freshness and admission tests, catalog/oracle equivalence tests, disk-spill
format/corruption/cancellation and build-run merge tests, the opt-in 1M spilled oracle suite
(`ORCA_RUN_PATH_SEARCH_SCALE=1 workspace-path-catalog-spill-scale.test.ts`), and the structural
performance contracts. Run the perf artifact harness described in
[`workspace-path-search-scale.md`](../../src/shared/__fixtures__/workspace-path-search-scale.md)
when measuring a new build; keep raw performance outputs in `docs/perf/` rather than this stable
contract page.
