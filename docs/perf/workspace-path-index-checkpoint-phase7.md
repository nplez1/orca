# Workspace path-index Phase 7 checkpoint measurements

## Scope

Phase 7 is the plan §8 row 7 exit: "fast last-known result after restart, corruption/identity tests
pass, reconciliation remains honest". The user approved it as **PROTOTYPE, THEN DECIDE**, so this page
records the measured checkpoint write/restore/reconcile cost against cold rebuild and gives the
verdict those numbers support. Raw numeric samples are in
[`workspace-path-index-checkpoint-phase7.json`](./workspace-path-index-checkpoint-phase7.json); the
implementation is specified in
[`workspace-path-catalog-block-format.md`](../reference/workspace-path-catalog-block-format.md#checkpoints)
and the cold-rebuild baseline is
[`workspace-path-index-matrix-phase6b.md`](./workspace-path-index-matrix-phase6b.md).

The verdict was **IMPLEMENT WITH LIMITS**, and the user kept the implementation with its deferred
items to be finished. **Follow-up (this revision):** that work is done — a bounded partial provisional
page, a resident re-encode opt-out, and an explicit checkpoint/spill disk budget — and re-measured
below. Follow-up samples live in
[`workspace-path-index-checkpoint-phase7-bounded-page.json`](./workspace-path-index-checkpoint-phase7-bounded-page.json)
(shipped default policy) and
[`workspace-path-index-checkpoint-phase7-bounded-page-resident-optin.json`](./workspace-path-index-checkpoint-phase7-bounded-page-resident-optin.json)
(resident re-encode opted in, the only configuration in which a resident root has a checkpoint).
The first campaign's file is unchanged and is the "before" column.

## Conditions

Apple M4 Pro, darwin/arm64, Node v26.0.0, vitest node worker threads. Shipped default admission
budgets (256 MiB root, 512 MiB host, 480 MiB build peak) are used, so the `resident` / `spilled`
column is what the real budget chooses rather than a forced mode. Same deterministic fixtures, seed,
and broad one-character query as the Phase 6b matrix. Per cell: one cold build, 3 checkpoint writes,
5 restarts (each a fresh worker **and** fresh service process objects) for load and first-provisional
page, then one reconciliation on a fresh restart. Raw samples contain counts, durations, and bytes
only — no paths, query text, or workspace identifiers. The follow-up campaign ran the same six cells
twice, once under the shipped default and once with `ORCA_PATH_INDEX_CHECKPOINT_RESIDENT=1`.

Reproduce with `ORCA_RUN_PATH_INDEX_CHECKPOINT=1 ORCA_PATH_INDEX_CHECKPOINT_SIZES=100000,500000,1000000 pnpm test src/main/workspace-path-index/workspace-path-index-checkpoint-matrix.test.ts`
and add `ORCA_PATH_INDEX_CHECKPOINT_RESIDENT=1` for the second report.

## The net-benefit table (baseline campaign, full-scan provisional page)

`cold build` is the same-session measured rebuild (all requested scopes ready). `write` is the
checkpoint write, `load` is a restart to a restored catalog object, `prov. p50/p95` is a restart to
the **first painted provisional page**, and `recon` is the restart to a fresh ready state. `link`
means the payload was hardlinked (already on disk, no new bytes); `encode` means a resident catalog
had to be compacted and re-encoded.

| Fixture                  | Storage | Cold build | First scope | Write | Payload | Form  | Load p50/p95 | Prov. page p50/p95 | Recon |
| ------------------------ | ------- | ---------: | ----------: | ----: | ------: | ----- | -----------: | ------------------ | ----: |
| realistic 100k           | resident |    2,735 ms |    1,752 ms |  935 ms |  7.2 MB | encode | 16.9/17.4 ms | **142/147 ms** | 2,771 ms |
| realistic 500k           | spilled  |   22,492 ms |    8,483 ms |   10 ms | 35.8 MB | link   | 17.1/18.9 ms | 571/591 ms | 23,063 ms |
| realistic 1M             | spilled  |   45,338 ms |   16,582 ms |   12 ms | 71.7 MB | link   | 17.8/35.4 ms | 1,158/1,198 ms | 46,353 ms |
| adversarial 100k         | resident |    4,706 ms |    3,211 ms | 2,125 ms | 56.6 MB | encode | 16.7/17.3 ms | 407/414 ms | 5,061 ms |
| adversarial 500k         | spilled  |   32,439 ms |   13,244 ms |   13 ms | 283.0 MB | link   | 16.8/17.4 ms | 1,896/1,910 ms | 33,674 ms |
| adversarial 1M           | spilled  |   65,246 ms |   26,122 ms |   15 ms | 566.0 MB | link   | 17.3/31.9 ms | 3,790/3,812 ms | 68,200 ms |

Supporting numbers: directory validation is 0.30–0.94 ms p50 (it reads the whole 24-byte-entry
directory), and the load *inside* the worker is 1.8–3.3 ms p50 — the rest of the 17 ms load is worker
spawn, which a restart pays anyway.

### What the baseline numbers said

- **Load is not the problem.** Restoring a validated catalog object is ~17 ms wall everywhere,
  ~10× inside the proposed 200 ms target. The 1M-path target for *loading* is met with wide margin.
- **Answering is the problem.** The proposed target is for "a clearly provisional page", and a
  restored snapshot is always `disk-spilled`, so the page costs a full spilled scan of the payload:
  142 ms at 100k realistic, 571 ms at 500k, 1.16 s at 1M realistic, and 3.8 s at 1M adversarial. The
  200 ms target holds only at ~100k realistic paths and is missed by 2×–19× above that.
- **Write cost depends entirely on shape.** A spilled generation checkpoints by hardlink: 10–15 ms
  and *zero* incremental bytes, because the `.wpc` already exists and the per-PID spill directory
  would have been cleaned up anyway. A resident generation needs a compaction plus re-encode, which
  measured 935 ms (realistic 100k, 34% of the build) and 2,125 ms (adversarial 100k, 45% of the build).
- **Disk per checkpoint** equals the payload: 7.2–56.6 MB for the resident 100k roots, 35.8 MB to
  566 MB for the spilled ones. For spilled roots that disk was already committed, so the checkpoint's
  marginal cost is zero.
- **Reconciliation is unaffected.** Restart-to-ready is 1.01–1.05× the cold build, and the restored
  provisional answers did not measurably slow it.
- **Restart semantics.** What the user gains is a labeled last-known page at 142 ms–3.8 s instead of
  either 1.8–26 s of silence (first scope) or 2.7–65 s of silence (all scopes). The gain is real and
  sized 6–14×, but the page is a *slow, degraded* page, not the ≤200 ms one the plan proposed.

## Verdict: IMPLEMENT WITH LIMITS

The prototype shows a genuine but bounded net win, so this is a "yes, with limits" rather than a
wholehearted "implement fully" or a "do not implement".

What justifies implementing:

- For a **spilled** root the checkpoint is nearly free: a hardlink, 10–15 ms, no new disk, and the
  restarted user gets a labeled page 6–14× sooner than silence.
- Correctness never depends on it. Every failure mode is "absent": missing, torn, foreign identity,
  changed folding or listing policy, corrupt header, corrupt directory, or a restore the host budget
  cannot account for. Disk-full, read-only, and corruption keep the live-scan path.
- Honesty is structural, not conventional. A restored root publishes as `provisional`, so replies
  carry `last-known` counts and can never claim an exact total or "No files match" until
  reconciliation promotes the root to ready.
- Reconciliation is not made worse, and the whole path is a no-op when
  `ORCA_DISABLE_WORKSPACE_PATH_INDEX=1`.

What limits it:

- **Resident roots are not worth checkpointing.** A 34–45% write overhead for 7–57 MB of disk buys
  the same provisional page a larger root would get, and every resident root is by definition small
  enough that the rebuild it avoids is short. The implementation keeps the resident encoder but
  refuses it up front when the host budget cannot hold the payload.
- **The 200 ms provisional-page target is not met above ~100k realistic paths.** Reaching it needs a
  design change, not tuning: a provisional answer would have to return a bounded page with
  `coverage: 'partial'` and a null count so the scan can stop early. That is a contract change and is
  deliberately left as follow-up rather than smuggled into this phase.
- **Provisional pages compete with reconciliation for worker CPU.** The 5-sample measurements showed
  no measurable slowdown, but at 1M adversarial each provisional page is a 3.8 s scan; a keystroke
  storm would need the same coalescing discipline the warm path already has.
- **Disk policy needs care.** 566 MB per 1M adversarial checkpoint is real if the root is not already
  spilled. The implemented 2 GiB host budget with one generation per root caps it, but a lower
  default (or a size-based opt-out) is a sensible follow-up now that the numbers exist.

Every limit above was taken up as approved follow-up and is re-measured in the next section.

Recommended follow-up, in order: (1) bound the provisional page with `coverage: 'partial'` and a null
count so the provisional-first-page target becomes reachable; (2) skip checkpointing resident roots by
default; (3) revisit the disk budget with the bounded-page design in place.

## Follow-up: the bounded provisional page

All three recommendations are implemented. A restored generation is marked `provisionalLastKnown` in
the worker, and its queries scan a **bounded natural-order prefix** — at most 128 blocks, 16 MiB of
encoded payload, or 100 ms, stopping as soon as the 5,000-row page is full — instead of the whole
payload. `prov. p50/p95` below is input-to-provisional-page for the shipped policy; the two resident
100k cells have no checkpoint at all under that policy, so they are shown from the opt-in run and
marked.

| Fixture          | Storage  | Prov. page p50/p95 before | Prov. page p50/p95 after | Blocks read | Reply state                     |
| ---------------- | -------- | ------------------------: | -----------------------: | ----------: | ------------------------------- |
| realistic 100k   | resident |          142 / 147 ms [1] |      19.4 / 20.1 ms [1]  |          20 | partial, no total, provisional  |
| realistic 500k   | spilled  |                571 / 591 ms |          19.0 / 20.0 ms |          20 | partial, no total, provisional  |
| realistic 1M     | spilled  |            1,158 / 1,198 ms |          19.7 / 28.3 ms |          20 | partial, no total, provisional  |
| adversarial 100k | resident |          407 / 414 ms [1] |      44.3 / 44.8 ms [1]  |          20 | partial, no total, provisional  |
| adversarial 500k | spilled  |            1,896 / 1,910 ms |          43.2 / 48.6 ms |          20 | partial, no total, provisional  |
| adversarial 1M   | spilled  |            3,790 / 3,812 ms |          45.0 / 48.9 ms |          20 | partial, no total, provisional  |

[1] Resident roots are not checkpointed by default, so there is no page to measure; these rows come
from the opt-in campaign (`ORCA_PATH_INDEX_CHECKPOINT_RESIDENT=1`) and exist only to show what the
bounded page costs *when* a resident root is checkpointed on purpose.

The same campaign re-run under the opt-in reproduced every spilled cell within noise, which is the
repeat-run evidence for these numbers: realistic 500k 19.6 / 26.2 ms, realistic 1M 21.4 / 27.7 ms,
adversarial 500k 44.3 / 69.1 ms (worst single sample in either campaign), adversarial 1M 44.3 /
47.4 ms. Every p95 is under 69 ms — at worst 0.35× the 200 ms target — and every cell read exactly 20
blocks, because a broad one-character query fills its 5,000-row page inside the first 20 blocks.
A selective query that matches nothing in the prefix stops on the budget instead and returns an empty
`partial` page; the budget, not the wall clock, is what the tests pin.

## Follow-up: checkpoint write cost and disk budget

`write` is the measured round trip through the worker; `writer-only` is the writer's own duration,
which is the number the baseline table recorded (it excluded the compaction).

| Fixture          | Storage  | Write before | Write after (shipped default)   | Write after (opt-in round trip / writer-only) | Payload (MiB) | Checkpoint bytes (MiB) | Live spill bytes (MiB) |
| ---------------- | -------- | -----------: | ------------------------------- | --------------------------------------------: | ------------: | ---------------------: | ---------------------: |
| realistic 100k   | resident |       935 ms | **refused, 0.13 ms, 0 B**       |                            1,804 / 940 ms |           7.2 |                    7.2 |                    0.0 |
| realistic 500k   | spilled  |        10 ms | 10.9 ms (hardlink, 0 new bytes) |                                12.1 / 11.8 ms |          35.8 |                   34.1 |                   71.7 |
| realistic 1M     | spilled  |        12 ms | 11.9 ms (hardlink, 0 new bytes) |                                12.7 / 12.2 ms |          71.7 |                   71.7 |                  143.4 |
| adversarial 100k | resident |     2,125 ms | **refused, 0.02 ms, 0 B**       |                            4,796 / 2,173 ms |          56.6 |                   56.6 |                    0.0 |
| adversarial 500k | spilled  |        13 ms | 16.4 ms (hardlink, 0 new bytes) |                                12.1 / 11.7 ms |         283.0 |                  283.0 |                  566.0 |
| adversarial 1M   | spilled  |        15 ms | 13.9 ms (hardlink, 0 new bytes) |                                12.8 / 12.2 ms |         566.0 |                  566.0 |                1,132.0 |

The disk math, against the shipped caps (768 MiB per root, 4 GiB host-wide for checkpoints **plus**
this process's live spill bytes):

- The worst measured checkpoint is 566 MB (1M adversarial), which fits the 768 MiB per-root ceiling
  with ~35% headroom; a root at roughly 2× that scale would be refused (`disk-budget`) instead of
  monopolizing the host cap.
- Six such checkpoints (3.4 GB) still fit the 4 GiB host cap; the seventh evicts the oldest whole
  checkpoint first. Live spills are never reclaimed by the checkpoint path, so a root refused at the
  cap simply keeps the live-scan/rebuild route with no provisional page and no correctness loss.
- `Checkpoint bytes` and `Live spill bytes` above are *apparent* bytes: a hardlinked checkpoint is the
  spill file's inode, so the real bytes are the smaller of the two columns, not their sum. Admission
  counts a hardlink at zero marginal bytes for exactly that reason.
- The default policy now spends **0 bytes and ~0.1 ms** on a resident root instead of 935–2,125 ms of
  build-lane CPU, and 4,796 ms of round trip when the opt-in is on.

## Honesty guarantees of the bounded page

- A bounded reply is `coverage: 'partial'`, `searchComplete: false`,
  `countProvenance: 'provisional'`, `degradationReason: 'partial-page-bounded'`.
- Its total count is **always `null`**. The checkpoint manifest carries `pathCount` (the snapshot's
  path total), never a per-query match count, so no total is projected from it — a partial page may
  not invent one, and it may never report `0` for a prefix where it simply stopped early.
- Only `coverage: 'complete'` + `freshness: 'no-known-gap'` + `countProvenance: 'exact-snapshot'`
  authorizes an exact total or "No files match". The renderer's empty-state policy
  (`getFileExplorerNameFilterEmptyMessageKind`) and its truncation notice already route every other
  state to "Only part of this workspace was searched — add more of the name to narrow it down"; no new
  copy was needed, and tests now pin the bounded and provisional cases.
- The page is a real prefix of the same `compareFileNames` order the complete answer returns, so it is
  a valid last-known page, not a resorted or truncated approximation, and the exact answer replaces it
  when reconciliation publishes.

## Verdict: IMPLEMENT WITH LIMITS (limits now closed)

The three limits recorded above are addressed, and the re-measurement supports closing them:

- **The 200 ms provisional-page target is now met at every measured size and shape** — 20–28 ms p95
  realistic, 45–69 ms p95 adversarial, with 20 blocks read regardless of catalog size — because a
  restored root answers from a bounded prefix and reports `coverage: 'partial'` with a null total.
- **Resident roots are no longer checkpointed by default.** The encoder is kept behind
  `ORCA_PATH_INDEX_CHECKPOINT_RESIDENT=1`; the default write is a 0.1 ms refusal with zero bytes and
  zero build-lane CPU, and the opt-in numbers (940 ms / 2,173 ms writer-only) show exactly what the
  default avoids.
- **The disk budget is explicit**: 768 MiB per root, 4 GiB host-wide shared with live spills,
  oldest-checkpoint-first eviction, and a `disk-cap` refusal that degrades to live-scan/rebuild.

What still limits it, honestly:

- **A bounded first page is not a complete answer.** Its rows can be empty even when later paths
  match, which is why the state is `partial` with no count and the pane may only say the workspace was
  not fully searched. A user who needs the complete list waits for reconciliation, exactly as before.
- **Provisional pages still compete with reconciliation for worker CPU.** The bound drops one page
  from 3.8 s to ~45 ms at 1M adversarial, so the contention argument is now 80× weaker, but the
  single-spill-query gate and the existing coalescing discipline are still what keep a keystroke storm
  bounded.
- **Resident roots that a user opts in still pay 34–45% of a build to checkpoint.** The opt-in exists
  for operators who want restart coverage on a small root; it is not the default for a reason.
