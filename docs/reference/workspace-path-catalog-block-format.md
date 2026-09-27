# Workspace path catalog blocks

Version-1 prefix blocks are the compact payload used by resident `prefix-compressed` catalogs and
by the host-local disk spill. The codec lives in
[`workspace-path-catalog-blocks.ts`](../../src/shared/workspace-path-catalog-blocks.ts); the disk
envelope and build runs live in
[`workspace-path-catalog-spill.ts`](../../src/main/workspace-path-index/workspace-path-catalog-spill.ts)
and
[`workspace-path-catalog-spill-runs.ts`](../../src/main/workspace-path-index/workspace-path-catalog-spill-runs.ts).
The design rationale and measured trade-offs are in
[plan §4.4 and §4.6](../explorer-name-filter-performance-plan.md).

## Block codec (version 1)

A block is a run of consecutive paths in `compareFileNames` natural order.

| Bound                                 |   Value | Constant                                        |
| ------------------------------------- | ------: | ----------------------------------------------- |
| Paths per block                       |     256 | `WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT`       |
| Combined original + folded code units | 131,072 | `WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT`  |
| Encoded original payload bytes        | 512 KiB | `SPILL_MAX_BLOCK_BYTES` / `RUN_MAX_BLOCK_BYTES` |
| Encoded folded payload bytes          | 512 KiB | same                                            |
| Resident decoded-block LRU            |   2 MiB | `WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES`     |

One exceptionally long path may occupy a block on its own; a path whose original payload alone
exceeds 512 KiB is rejected rather than truncated.

Original and folded text are separate prefix-compressed streams. Each entry is an unsigned-varint
common-prefix length measured in UTF-16 code units, an unsigned-varint suffix byte length, then the
suffix bytes. Original suffixes are UTF-8; folded suffixes are UTF-16LE. Prefixes reset at every
block boundary. The four offset domains stay independent: stable path ID, natural-order rank,
original UTF-8 byte offset, and folded UTF-16 code-unit offset. Locale folding can change length, so
the two numeric offset tables are never reused for each other. Prefixes never split a surrogate
pair.

Each block carries three CRC-32/ISO-HDLC checksums: one over the encoded original payload, one over
the encoded folded payload, and one over the one-byte-per-path flags array. The implementation in
[`workspace-path-catalog-block-checksum.ts`](../../src/shared/workspace-path-catalog-block-checksum.ts)
uses a 256-entry table (one lookup per byte); a spilled 1M scan validates ~0.6 GB of payloads per
query, and the previous bit-at-a-time loop dominated its decode time. `decodeWorkspacePathCatalogBlockPayloads`
verifies all three before decoding; the disk and run readers verify the original and folded bounds and
checksums before returning any path.

### Decoded-block cache semantics

`getWorkspacePathCatalogBlockPath` serves resident `prefix-compressed` random access through a
per-catalog LRU keyed by block index, bounded to 2 MiB and accounted from the decoded
original/folded strings plus flags. It is a **bounded active-decoding window**, not a whole-catalog
cache: an oversized block is decoded for the current read and immediately evicted, and the window
only holds a few blocks of a 1M-path catalog. Hit/miss counters are per catalog
(`workspacePathCatalogPrefixCacheCounters`).

The disk spill reader does **not** use this LRU. A spilled query scans every block exactly once in
natural order, so there is no cross-query reuse to report; the query metrics set
`decodedBlockCacheHits: 0` for disk-spilled answers. Do not read that counter as "the cache was
consulted and missed" — the disk path has no cache lookup.

## Spill file envelope (`.wpc`)

The writer stages a same-directory `*.spill.tmp` file (mode `0600`), `fsync`s it, and atomically
`rename`s it to `*.wpc`. On any failure both the temp and final paths are removed. Spill files live
under the host-local per-process spill directory in Orca user data, never inside the workspace.

```text
offset 0                 magic "ORCAPIDX" (8 B)
offset 8                 headerLength: u32 LE (JSON header byte length, 1..32768)
offset 12                JSON header (headerLength bytes) inside a 32 KiB reserved region
offset 32780             block directory: pathCount x 24-byte entries
offset 32780 + 24*N      block payload region
```

`SPILL_HEADER_RESERVE_BYTES` is 32 KiB and `SPILL_DIRECTORY_ENTRY_BYTES` is 24. The declared
`pathCount` fixes the directory capacity, so every directory entry has a fixed offset and blocks can
be read in any order; the sequential reader still enforces natural order by design.

JSON header fields: `schema` (`workspace-path-catalog-spill`), `schemaVersion` (1),
`blockFormatVersion` (1), `identityHash` (SHA-256 hex of the identity key), `generationId`,
`pathCount`, `blockCount`, `directoryCapacity`, `foldVersion`, `foldLocale`, `scopeRuleVersion`, and
the catalog `metadata` (fold locale/version, scope-rule version, included/all/classification
completeness, coverage excludes, freshness).

Each 24-byte directory entry is: `count` u32, `originalLength` u32, `originalChecksum` u32,
`foldedLength` u32, `foldedChecksum` u32, `flagsChecksum` u32. The payload region stores, per block
in natural order, `original | folded | flags` back to back. Because the directory is written in
place after the payload blocks, the on-disk payload order is exactly the natural-order block order.

Reader validation, in order: magic; header length within the 32 KiB reserve; JSON shape and enum
values; `identityHash` equals the SHA-256 of the supplied identity key and the value recorded on the
catalog; `generationId`, `foldVersion`, `foldLocale`, and `scopeRuleVersion` match the catalog; the
catalog's header/directory/data offsets match the formula above; `blockCount` and `pathCount` agree
with the live file size. Per block, the reader rejects zero or over-limit counts, over-limit payload
lengths, a payload that would run past EOF, and any out-of-order or unknown block index. After the
last block it requires the ranks seen to equal `pathCount`. Any failure throws; the query path treats
it as corruption, never as an empty result.

### Disk budget, cleanup, and reader-safe deletion

- The writer refuses to plan a directory region beyond its budget and re-checks
  `dataOffset + dataBytes` after every block; `SPILL_MAX_DISK_BYTES` and
  `SPILL_DISK_BUDGET_BYTES` are both **4 GiB**.
- `cleanStaleWorkspacePathCatalogSpillDirectories` deletes numeric PID subdirectories under the
  spill root whose owning process is not alive (`EPERM` counts as alive). The runs builder enforces
  the 4 GiB budget against the whole process directory, not one file.
- `prepareWorkspacePathCatalogSpillDirectory` clears leftover `.wpc`, `.run`, and `.tmp` files in
  the process directory before a new build.
- Generation/root disposal calls `removeWorkspacePathCatalogSpill`. If readers are active the
  deletion is deferred (`pendingSpillDeletes`) until the last reader closes, so an in-flight scan
  never reads a deleted file.

## Build runs (`.run`)

Disk builds never materialise a catalog-sized string map. `WorkspacePathCatalogSpillRuns` accepts
bounded batches, folds and dedupes a chunk, writes a checksummed sorted run, and performs a leveled
merge.

```text
offset 0   magic "ORCARUN1" (8 B)
offset 8   version: u32 LE (1)
offset 12  pathCount: u32 LE
then       blocks: 24-byte block header, then original | folded | flags
```

The 24-byte run block header is the same six u32 fields as a spill directory entry
(`count`, `originalLength`, `originalChecksum`, `foldedLength`, `foldedChecksum`, `flagsChecksum`).
Run blocks use the same version-1 codec and the same 256-path / 131,072-code-unit / 512 KiB bounds.
`RUN_CHUNK_PATHS` is 4,096 pending records per scope before a flush, so the dedupe map stays bounded.
`RUN_MERGE_FAN_IN` is 16: at most 16 sorted cursors are open, and each level merge produces a new run
one level higher, still in `compareFileNames` natural order. Both discovery scopes (`included`,
`all`) merge with cross-scope dedupe and flag classification. Every run write is checked against the
shared 4 GiB directory budget, and the builder yields to the event loop every 128 records after 8 ms.

`finishFirstScope` publishes an atomic `.wpc` containing only the first completed scope so a query
can answer before the second scope finishes; `finishAllScopes` merges both scopes and publishes the
complete generation. Both outputs are ordinary spill files with the header above.

## Memory reservations

Admission separates two numbers instead of reserving one catalog-sized block:

| Reservation           |   Value | Constant                                            |
| --------------------- | ------: | --------------------------------------------------- |
| Root retained catalog | 256 MiB | `WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES`     |
| Host process budget   | 512 MiB | `WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES`     |
| Host build peak       | 480 MiB | `WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES` |

The root cap covers retained bytes (typed offset/order/flag arrays and any resident blocks); the host
build-peak reservation covers the transient merge/scratch of a disk build. This is what lets a 1M
catalog be admitted with only ~15 MB of retained typed arrays while a build still has a measured
transient ceiling. The numbers are measured bounds for this campaign, not universal constants; see
[`workspace-path-index-matrix-phase6b.md`](../perf/workspace-path-index-matrix-phase6b.md).

## Checkpoints

A disk spill and a restart checkpoint share the same version-1 block payload: a checkpoint is a
`.wpc` file inside a per-identity directory under `<user data>/workspace-path-checkpoints/`, plus a
small `manifest.json`. The block codec alone does not imply checkpoint freshness — a checkpoint is
never proof of current filesystem state, and a restored generation is served as provisional
last-known results until reconciliation replaces it.

Code lives in [`workspace-path-catalog-checkpoint-manifest.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-manifest.ts),
[`-checkpoint-store.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-store.ts),
[`-checkpoint-writer.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-writer.ts),
[`-checkpoint-restore.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-restore.ts),
[`-checkpoint-payload-validation.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-payload-validation.ts),
[`-checkpoint-policy.ts`](../../src/main/workspace-path-index/workspace-path-catalog-checkpoint-policy.ts) and
the shared [`workspace-path-provisional-page-budget.ts`](../../src/shared/workspace-path-provisional-page-budget.ts).

### Directory layout and manifest

```text
<user data>/workspace-path-checkpoints/<identityHash>/manifest.json
<user data>/workspace-path-checkpoints/<identityHash>/<generationId>.wpc
```

`identityHash` is the SHA-256 of a JSON identity key: execution provider, authorized canonical root,
checkpoint schema version, listing-policy version, fold version, and fold locale. A **remote**
provider's incarnation is part of that key; the **local** provider's incarnation is the OS pid, which
changes on every restart, so it is deliberately excluded — a checkpoint that a restart invalidated
would be pointless. This is the one place where the checkpoint identity intentionally differs from
the in-process ownership key.

The manifest records the schema and block-format versions, the identity hash, the payload file name
and byte length, the SHA-256 the payload header carries for the write-time ownership key, the
generation id, the published scope, path/block counts, fold version/locale, scope-rule version, and a
write timestamp. The writer publishes the manifest last — temp file, `fsync`, `rename` — so a crash
mid-write leaves either the previous checkpoint or none, never a manifest pointing at a partial
payload. One generation is retained per identity; older payload files are pruned after the swap.

### Disk budget

Checkpoint bytes and this process's live spill bytes spend one host cap of **4 GiB**
(`WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES`, the same number as the spill root's own
cap), and a single identity may hold at most **768 MiB**
(`WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES`), which is room for the measured
1M-adversarial worst case (566 MB) with headroom. Disk admission runs **before** the payload is
written, so a refused checkpoint never lands:

1. Live spill bytes (this process's spill directory, measured by the call that knows it) plus every
   existing checkpoint are summed.
2. Whole checkpoints are evicted oldest-first until the total fits. A checkpoint is a rebuildable
   optimization; a live spill may be pinned by an in-flight scan, so **spills are never reclaimed
   by the checkpoint path**. PID-dead spill directories stay `cleanStaleWorkspacePathCatalogSpillDirectories`'
   job, as before.
3. If the total still does not fit, the write is refused (`disk-cap`) and the root keeps the
   live-scan/rebuild path. That costs a provisional page and never correctness.

A **hardlinked** checkpoint shares the spill file's inode, so it adds no storage; its marginal cost
is counted as zero when deciding admission, but its apparent size counts toward the cap like any
other checkpoint (conservative, and it makes the oldest hardlinked checkpoint the cheapest thing to
swap out). The per-root ceiling is checked first and refuses an oversized payload (`disk-budget`)
before any encode starts.

### Write

A completed generation is checkpointed from the worker, never from the main thread:

- A `disk-spilled` generation is **hardlinked** into the checkpoint directory. The payload file
  already exists, so the write is O(1) and adds no disk bytes — the spill directory is per-PID
  scratch that is cleaned up later, and the checkpoint's link is what keeps the inode alive.
- A **resident** generation must first be merged into one snapshot (a base catalog plus an overlay is
  not a checkpoint unit: the `.wpc` cannot represent a delta), then re-encoded through the bounded run
  merge. That costs a compaction plus a full re-encode — 34–45% of a build — so it is **off by
  default**: it runs only under an explicit opt-in
  (`ORCA_PATH_INDEX_CHECKPOINT_RESIDENT=1`, resolved by
  `workspacePathCatalogResidentCheckpointEncodeEnabled`), and the worker refuses it before starting
  the compaction (`resident-encoder-disabled`). A resident root is small enough that the rebuild it
  avoids is short, and plan §7 forbids coupling an active root's correctness — or its CPU — to
  checkpoint success. A spilled root keeps zero-marginal-cost checkpointing unconditionally.
  When the opt-in is on, the encode is still refused up front when the root ceiling cannot hold the
  payload (`disk-budget`).

The published scope is derived from the catalog's own metadata (`includedComplete` / `allComplete`),
never from a caller claim, so a half-built snapshot cannot be persisted as a complete checkpoint.
Writes are fire-and-forget off the interactive path, and the whole path is inert when
`ORCA_DISABLE_WORKSPACE_PATH_INDEX=1`.

### Restore

Restore is worker-side only — never deserialize a large catalog on the main thread. Validation, in
order: the manifest must exist, parse, and match the directory name, and its payload must still be
the declared length; fold version, fold locale, and scope-rule version must match the values the
execution host resolved for itself; the payload header must parse and agree with the manifest on
identity, generation, counts, block format, fold, and scope rule; and the whole block directory is
read and validated (counts, per-block payload lengths, accumulated offsets, allocation limits, and
the total path count) before the catalog is constructed. Per-block checksums stay lazy in the reader,
so a damaged payload body fails on read as a corruption error rather than an empty result.

Every failure — absent, torn, foreign identity, changed folding or listing policy, corrupt header,
corrupt directory, unaffordable restore — is treated as **absent**. An active root's correctness
never depends on checkpoint success, and disk-full/read-only/corruption keeps the live-scan path.

A restored catalog is `disk-spilled` and carries synthetic identity `naturalOrder` plus zero-filled
offset and flag arrays: the spilled read path takes paths and flags from the decoded blocks, so those
arrays exist only to keep the catalog's shape and its retained-byte accounting identical to a written
one. Restoring therefore does not rebuild `foldedOffsets` from a sidecar or from a full decode.

A successful restore publishes with **provisional** freshness and `needsRebuild`, so queries are
answered from last-known rows labeled `last-known` (never `exact-snapshot`, so a provisional restore
can never show “No files match” or an exact total) while a full reconciliation build runs and then
promotes the root to ready. For a **spilled** restore the worker also marks the in-memory generation
`provisionalLastKnown`, and its queries run against a **bounded natural-order prefix** instead of a
full spilled scan: at most 128 blocks, 16 MiB of encoded payload, or 100 ms
(`WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET`), stopping as soon as the retained page is full. Such a
reply carries `coverage: 'partial'`, `searchComplete: false`, `count: { value: null, provenance:
'provisional' }`, and `degradationReason: 'partial-page-bounded'`. The count is deliberately null:
the manifest's `pathCount` is the snapshot's path total, not this query's match count, so it is
never projected as one. The bounded page is a real prefix of the same `compareFileNames` order the
complete answer would return, so it needs no re-sort, and the complete answer still arrives when
reconciliation publishes. A restore the host budget cannot account for is refused, and a restored
generation is dropped rather than allowed to block its own reconciliation. Deleting a root's
checkpoint happens on authorization revocation, in both the ensure-time and explicit-revoke paths.

Filenames never leave the host: checkpoint bytes are read and written only by the execution host's
own worker and user-data directory. Nothing mirrors a checkpoint over RPC or the relay — a test in
[`workspace-path-index-checkpoint-freshness.test.ts`](../../src/main/workspace-path-index/workspace-path-index-checkpoint-freshness.test.ts)
fails if any checkpoint identifier appears under `src/relay`, `src/shared/rpc-contract`,
`src/renderer`, or `src/preload`.

### Measured limits

The Phase 7 prototype measured restore and write cost against cold rebuild; the numbers, the
per-cell table, and the recommendation are in
[`workspace-path-index-checkpoint-phase7.md`](../perf/workspace-path-index-checkpoint-phase7.md).
Restore itself is consistently ~17 ms wall (worker spawn included; ~3 ms inside the worker). The
prototype's first provisional page cost a full spilled scan (142 ms at 100k realistic paths, 1.16 s at
1M realistic, 3.79 s at 1M adversarial), missing the proposed 200 ms target above ~100k; the bounded
prefix replaces that scan and the follow-up campaign measures it under 50 ms p95 at every size and
shape, with resident roots no longer checkpointed by default.
