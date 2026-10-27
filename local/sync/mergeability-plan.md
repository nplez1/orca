# Mergeability plan — making the upstream sync cheap

Baseline measured **2026-10-26** at `8da9849c43`, seven analysis passes over the conflict set, the
patch series, the product line, the test gates and the sync tooling. This is a plan, not a change:
nothing here has been implemented, and no suites were run to produce it.

Companions: [UPSTREAM-SYNC-RUNBOOK.md](../../UPSTREAM-SYNC-RUNBOOK.md) (the process),
[convergence-ledger.md](./convergence-ledger.md) (which side wins per subsystem),
[LOCAL-PATCHES.md](../../LOCAL-PATCHES.md) (the patch series), [BRANCHES.md](../../BRANCHES.md)
(branch state), [README.md](./README.md) (the sync scripts).

---

## 1. The baseline, in numbers

| Fact                              | Value                                                          | Where it comes from                                    |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| Sync cadence                      | **11 syncs in 20 days**, each 50–628 upstream commits          | `git log --merges --first-parent`                      |
| Upstream velocity                 | **150–255 commits/day**                                        | `git log upstream/main --since=60.days`                |
| Pending sync (now)                | 174 upstream commits                                           | `upstream/main` = `5fea2893f6`                         |
| Predicted conflicts               | **233 paths / 336 hunks**                                      | `conflicts.mjs --merge-tree HEAD upstream/main --json` |
| …of which comment-sweep only      | **162 paths** caused solely by `7d6603aa17`                    | per-path `git log 0571e45107..upstream/main`           |
| …of which real upstream work      | **70 paths**                                                   | same                                                   |
| …on upstream-owned files          | **230 of 233**                                                 | `git ls-tree upstream/main`                            |
| Comment-only hunks                | 65 of 336 (19%)                                                | hunk classifier over `conflicts.json`                  |
| Conflict classes                  | 151 both-rewrote, 50 union, 30 modify/delete, 2 duplicate-tail | `conflicts.json`                                       |
| Fork footprint                    | 1,585 file paths upstream does not have                        | `comm -23` of both trees                               |
| Fork-only import breakage pending | 19 files / 8 renamed modules                                   | rename map × fork-only importers                       |
| Follow-up commits per sync        | **median ~7** (4–12)                                           | sync log + first-parent commits                        |
| Known-red allowlist               | **40 entries / 18 files**, all `owner: upstream`               | `local/unit-known-red.json`                            |
| Nightly backstop                  | **ran once, ever** (2026-10-08)                                | `gh run list --workflow fork-main-tests.yml`           |
| Unit gate runtime                 | 1,227 s (10-22) → **2,575 s** (10-25), cap 3,600 s             | gate log                                               |

**The number that matters is the last four rows, not the 233.** A repo-wide upstream sweep inflates
the current set; the structural cost is the recurrent 70, the ~7 follow-up commits, and a backstop
that is not running.

### The cost model

A sync costs four separate things, and they are paid in this order:

1. **Resolution** — 70 real conflicted paths, resolved once each, competently.
2. **Silent breakage** — upstream renames and deletions that no conflict marker points at, found by
   `pnpm tc` (every sync since 10-09) and by the unit gate. This is what turns a 1-hour merge into a
   10-hour one (10-18: 10.2 h).
3. **Follow-ups** — lint/catalog/mock/identity repairs after the merge: median ~7 commits.
4. **Base drift** — after 10-25 **no branch contains the release tip**; every open branch must be
   caught up before `local/open-pr.mjs` will accept it.

Only (1) is visible in the conflict count. (2)–(4) are why the sync feels expensive.

---

## 2. Root causes, ranked by measured leverage

Each cause below is followed by its evidence. The plan in §3 is organised to attack them in this
order.

**R1 — The fork edits upstream-owned files inline. 230 of 233 conflicted paths are upstream files,
not fork files.** Nothing in the product line is badly isolated as a _directory_
(`workspace-path-index`, `session-summary`, `jenkins`, `host-sync` produce 0 conflicts); the
collisions are at **seams** — rate-limits, status bar, AI Vault shared types, dashboard, pi,
store slices. Restructuring the seams is the only change that removes conflicts permanently.

**R2 — The `max-lines` cap makes the fork evict _upstream_ code.** `.oxlintrc.json:180,186` caps
`.ts` at 300 and `.tsx` at 400 code lines. Upstream keeps hot files at 292–300, so the remedy for
an over-budget file has been to move _upstream's_ block into a fork file. ~25 hunks this sync come
from that move, and each one also risks **silent drift**: upstream's edit lands in a block the fork
owns a stale copy of. The ledger's own rule (`convergence-ledger.md:768`) says the fork's addition
is what must move. In practice it has not been.

**R3 — Fork comments live in upstream files.** `7d6603aa17` (upstream's comment cleanup, 16,196
files) accounts for **162 of 233 paths**; 73% of the current hunks have an upstream side that
changes only comments; 35 hunks are fork-comment against upstream-comment. Fork rationale in
upstream files is pure conflict adjacency and buys nothing a commit message or `LOCAL-PATCHES.md`
does not.

**R4 — Generated/derived artefacts are written by both sides.** `en.json` conflicted in **12 of the
last 12 syncs**, `en-runtime-required.json` in 8, and the ratchet baselines
(`config/focus-setting-read-baseline.txt`, `config/flaky-test-pattern-baseline.txt`) conflict
whenever either side fixes a violation. These are append-only files with one writer assumed.

**R5 — The fork deletes upstream files instead of neutralising them. 19 of the 30 modify/delete
paths are "fork deleted, upstream still editing"**, 14 of them the dashboard/popout set. Deletion is
a decision the fork must re-apply every sync, and each upstream edit to the deleted file is a new
conflict. (Only 2 are "upstream deleted, fork modified".)

**R6 — Upstream renames reach fork-only files with no conflict marker.** 185 pending renames; today
**19 fork-only files import a path that will disappear**, across 8 modules. This is the class the
BRANCHES.md entries describe as "fork-owned files that nobody conflicted on had to follow those
renames", and it costs a full `pnpm tc` round every sync.

**R7 — The fork duplicates capabilities upstream has since shipped.** The pi session-owner fence
(fork: ~650 lines; upstream `f37c1f6b95`: 54), the Claude spend cap (upstream `cffb527b82`), the
`codex-subagent-roster` rename, the TUI config split (492 lines vs upstream's 361, of which ~130 are
a copy), the Copilot title fix, and `skill-freshness.ts` (205 lines, on no live path). Each is
divergence that could be zero.

**R8 — Test and tooling debt hides the cost.** 40 allowlisted failures of which ~33 look provable by
environment (`bash` 3.2 vs 5, `/private/var` vs `/var`, bun 1.4.4 + Apple SQLite); the flake waiver
diffs against `merge-base(nplez1/main, HEAD)` which is **empty on the release line**, so every
isolated re-run pass is waived after a merge; the nightly that replaced the per-PR suite has not
run; `check:changed` still defaults its base to `origin/main`, i.e. upstream, so the pre-handoff
gate diffs the fork's entire 2,846-file delta.

---

## 3. The plan

Effort: **S** ≤ 2 h, **M** ≤ 1 day, **L** > 1 day. Impact is stated as
_syncs-affected × work-removed_, using the baseline above.

### P0 — Stop the bleeding (≈1 day, all low risk)

| #    | Item                                                                     | Why                                                                     | Effort | Impact                                                                 |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| P0.1 | Prove the nightly backstop runs (§4.1)                                   | The PR gate traded the full suite away for it; it has one run ever      | S      | restores the safety net the whole verification tier assumes            |
| P0.2 | Empty branch diff is `unknown`, never waived (§4.2)                      | Waives _every_ flake after every merge                                  | S      | stops hidden merge flakes reaching `nplez1/main`                       |
| P0.3 | Gate preflight: daily liveness only (§4.3)                               | Two of the three proposed checks turned out to be false                 | S      | see § 4.3 — dropped on evidence; the liveness check shipped separately |
| P0.4 | `check:changed` base `origin/main` → `origin/HEAD` (§4.4)                | Diffs 2,846 files on every handoff, unqueued                            | S      | minutes per handoff; less memory pressure                              |
| P0.5 | Per-entry `match` on known-red failure detail (§4.5)                     | An allowlisted test can start failing for a new reason and stay "known" | S      | stops 40 tests masking regressions                                     |
| P0.6 | **Comment policy**: no fork comments in upstream files (§4.6)            | 162 of 233 paths, 35 hunks                                              | S      | removes the largest single class                                       |
| P0.7 | Ledger `Resolution:` field, narrower Identity glob, coverage line (§4.7) | `src/**` in Identity makes "has a ledger entry" match 227/233           | S–M    | makes the resolver in P1.9 possible                                    |
| P0.8 | Ratchet baselines → fork overlay (§4.8)                                  | Two conflicts per sync, both pure bookkeeping                           | S      | −2 paths/sync                                                          |
| P0.9 | Delete the 4 dead modules (§4.9)                                         | Verified 0 importers                                                    | S      | −290 lines, no risk                                                    |

### P1 — Re-architect the seams (2–3 weeks; the real win)

Ordered so each item is independently shippable and independently valuable.

| #    | Item                                                                                            | Removes                                                                         | Effort | Risk                                                                    |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| P1.1 | **i18n fork overlay catalog** (§5.1)                                                            | `en.json` conflict in 12/12 syncs, `en-runtime-required` in 8/12                | M      | medium — `config/**` is a global input, needs a full gate               |
| P1.2 | **Restore upstream blocks evicted for `max-lines`** (§5.2)                                      | ~25 hunks now, 3–5 files/sync, plus silent drift                                | M      | medium — must re-check budgets                                          |
| P1.3 | **Fork usage-provider table** (status bar + rate-limits sibling lane) (§5.3)                    | the ledger's "single most repeated conflict shape": 21 hunks / 14 files         | M      | low–medium — settle order and the privacy gate                          |
| P1.4 | **Dashboard: restore upstream, add a `'page'` mode** (§5.4)                                     | 14 modify/delete paths permanently                                              | M      | medium — 3.3k lines back; typecheck the store                           |
| P1.5 | **TUI config overlay** (§5.5)                                                                   | 2 hunks + the "table edits arrive silently" trap; −130 lines                    | S      | low                                                                     |
| P1.6 | **Small seams**: `worktree.remove`, `orcad-entry`, `agent-hook-listener`, settings types (§5.6) | ~9 hunks over the hottest files in scope                                        | M      | low–medium                                                              |
| P1.7 | **pi: adopt upstream's owner fence; restore the roster path** (§5.7)                            | ~650 duplicate lines, 1 modify/delete, importer rewrites                        | M      | medium — gated on the fork's #68 cases                                  |
| P1.8 | **Identity: electron-builder overlay; identity lint out of `package.json`** (§5.8)              | 66+89 lines in a 41-commits/month file; a 100-commits/month `package.json` line | S–M    | low                                                                     |
| P1.9 | **Proof-tier resolver + rename forecast + fork-symbol survival** (§5.9)                         | ~60–75% of hunk resolutions; the whole R6 class                                 | M      | medium — a lexer error must never take ours over a real upstream change |

### P2 — Reduce divergence and pay down infra (ongoing)

| #    | Item                                                                                                 | Why now / why not sooner                                                                                                                                                                                      | Effort   |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| P2.1 | Fork-surface smoke selector: 5-minute "did the merge break it" check (§6.1)                          | Needs P1.9's path list; measured 954 fork-touched test files = 8.8 test-minutes                                                                                                                               | M        |
| P2.2 | Nightly Linux report cross-check → turns 33 "environment-bound" claims into checks (§6.2)            | Needs the nightly running (P0.1)                                                                                                                                                                              | M        |
| P2.3 | Upstream-facing PRs (§6.3)                                                                           | **Outward-facing: needs an explicit decision.** Best candidates: usage-provider kill-switch, Copilot provider, AI Vault paging, pi mtime fix, BEL detector, `orca-repository` constant, `app-directory-names` | M each   |
| P2.4 | Adopt upstream's Claude spend cap; drop the fork half (§6.4)                                         | Lands with a sync; ~350 lines                                                                                                                                                                                 | S        |
| P2.5 | AI Vault: fork-owned side table + own schema version (§6.5)                                          | The shared version trap has already cost two merges (6→10 vs 6→8)                                                                                                                                             | M        |
| P2.6 | Renderer tidying: `main.css` → colocated CSS, `ForkUiSlice`, Jira board hook (§6.6)                  | Low recurrence; do it opportunistically                                                                                                                                                                       | S–M each |
| P2.7 | Branch base-drift policy + tooling (§6.7)                                                            | Every branch is behind; 13 branches, 0 open PRs                                                                                                                                                               | M        |
| P2.8 | Gate cost: shared verdict cache, batched re-runs, runtime investigation (§6.8)                       | 2,575 s against a 3,600 s cap                                                                                                                                                                                 | S–M      |
| P2.9 | Retire `curate.mjs`, fix the "rebase the patch series" wording, revisit the `commit-msg` hook (§6.9) | The thing the docs describe does not exist                                                                                                                                                                    | S        |

---

## 4. P0 detail

### 4.1 Prove the nightly backstop runs

`fork-main-tests.yml` has **one run, ever** (2026-10-08, green, 12m34s). It was re-enabled
2026-10-25 04:56 UTC; its cron is `53 4 * * *` UTC, and no run exists for the 2026-10-26 04:53 UTC
slot. Other scheduled workflows on this repo (`Mirror upstream release tags`) do fire, so schedules
work.

Two candidate causes, both cheap to settle:

- it `uses: ./.github/workflows/unit-tests.yml`, which is `disabled_manually` here. Whether a
  disabled reusable workflow can be called is untested.
- the plan job may be failing at parse/dependency time without creating a run.

```bash
gh workflow run fork-main-tests.yml --repo nplez1/orca    # ~50 billed minutes
gh run list --workflow fork-main-tests.yml -L 3
```

Decide from the result: fix the call, or make the workflow self-contained (inline the reusable
jobs) so repo-level workflow enablement cannot silence it. Then add a heartbeat check to
`local/check-actions-enablement.mjs`-adjacent tooling that reports "no run in 48 h" instead of
leaving it to be noticed.

### 4.2 The flake waiver is blanket on the release line

`gate-unit.mjs:169-178` diffs `merge-base(nplez1/main, HEAD) .. HEAD`. A sync is merged **onto**
`nplez1/main`, so on the release line the merge-base _is_ HEAD, the diff is empty, and
`flakeWaiver` (`gate-flake-coupling.mjs:162-171`) then finds no coupled path for any test, so every
failure that passes in isolation is waived. The `7811f60dd6` PASS — "1 flaky re-run passed" — was
judged against an empty diff immediately after a 556-commit merge.

Fix: when the merge-base equals HEAD, fall back to a base that has content — the merge's first
parent, or the last gated revision — and if neither resolves, return `unknown`, which already means
"never waive". One condition, one test.

### 4.3 Gate preflight — **dropped, on evidence**

Proposed: check `mobile/node_modules`, the pinned Playwright browsers, a 5-second probe run, and
`gh run list` freshness before spending 43 minutes. **Two of those were wrong, and I verified it rather
than shipping them:**

- `mobile/node_modules` does not exist in this worktree and the suite is green (`ls -d mobile/node_modules`
  → absent). pnpm hoists the mobile deps into the root install, so a check for that directory would
  have failed a healthy tree and blocked every gate run. This worktree's last full run passed with it
  absent, which is the proof that the proposed check is a false positive and not a real guard.
- The `bun` on `PATH` is 1.4.3 while `config/.bun-version` pins 1.4.4, which looks like the
  "silently did not run" hazard — but it is not: `config/scripts/run-vitest.mjs:17` prefers
  `resolvePinnedBunExecutable`, which resolves the pin from a **devDependency** (here
  `/Volumes/Storage/.pnpm-store/.../bun/1.4.4/...`). PATH is only the fallback, so a version check on
  PATH would have guarded the path that is not used.

The remaining ideas are not worth a check: a broken runner config already exits in seconds, and the
43-minute failure mode this was meant to prevent was the _queue_, not the environment.

What did ship: `local/check-nightly-liveness.mjs`, as a standalone check rather than a gate step,
because it answers "is the backstop alive" (a question about the repo) rather than "can this suite
run" (a question about the tree). See `LOCAL-PATCHES.md` § `local(ci)`.

### 4.4 `check:changed` base

`config/scripts/check-changed.mjs:48` tries `origin/main` before anything else; on this fork that is
upstream's mirror, so the pre-handoff gate diffs the fork's whole 2,846-file delta.
`check-changed-code-quality.mjs:153-157` already fixed exactly this bug with `origin/HEAD` first.
Make the two agree. One line, in an upstream file — the only reason it is P0 rather than P2 is that
it runs before every handoff.

### 4.5 Known-red must match the reason, not just the name

`unit-gate-judgement.mjs:60-64` matches `file === file && test === test`; the collected `detail`
(`:40`) is ignored. Every entry's `evidence` already contains the signature worth matching
(`mapfile: command not found`, `/private/var`, `unable to open database file`, `ENOTEMPTY`).
`gate-lint.mjs:143-154` already supports a per-entry `match` regex — mirror it. Also tighten the
unhandled-error entries (`:92-108`), which currently match on headline alone for any file and any
count, so `pool-crash` waives a worker crash anywhere in the suite.

### 4.6 No fork comments in upstream files

The rule: **rationale goes in `LOCAL-PATCHES.md`, the ledger, the commit message, or a fork-owned
module — never in an upstream file.** Restoring upstream's comment text byte-for-byte is always the
right resolution. Two consequences to encode:

- in the resolver (P1.9), "upstream's side differs from base only in comments" ⇒ take **ours**
  verbatim, which is provably correct and covers 249 of 336 hunks today;
- in review, a fork hunk that only adds comments to an upstream file is a finding.

This is the single highest ratio in the plan: cost zero, removes 65 hunks now and the whole class
afterwards. It also explains the ~25 comment lines in `config/electron-builder.config.cjs` and the
re-added "Why" block in `updater-prerelease-feed.ts`.

### 4.7 Make the ledger machine-usable

- Add `**Resolution:** keep-ours | take-theirs | delete | rerere | manual` to every subsystem
  section. The tooling currently has prose only (0 occurrences of `Resolution:`), so
  `modify/delete` handling is re-decided by a human every sync.
- Narrow the Identity section's `**Paths:**` from `src/**`, `config/**`, `mobile/**` to the actual
  identity files. Today it matches 227 of 233 paths, which makes "has a ledger entry" meaningless.
- Have `conflicts.mjs --summary` print **"N conflicted paths have no ledger decision"**, excluding
  catch-all sections. Today 156 of 233 have no subsystem decision.
- Stop filing decisions into per-sync sections (36% of the ledger). A per-sync section should record
  _what happened_; a decision belongs in the subsystem section it applies to.

### 4.8 Ratchet baselines as an overlay

`config/focus-setting-read-baseline.txt` and `config/flaky-test-pattern-baseline.txt` are
per-file, sorted, monotonic counters. Both sides bump them and they conflict on adjacent lines.
Give each checker (`check-focus-read-ratchet.mjs`, `check-flaky-test-pattern-ratchet.mjs`) a
fork-owned overlay file that it merges with upstream's: upstream's baseline stays byte-identical,
the fork records only the files whose count differs. Removes 2 paths/sync and also removes the risk
of silently loosening upstream's ratchet.

### 4.9 Delete the dead modules

Verified 0 importers: `src/renderer/src/components/task-page-jira-board-page-state.ts` (36),
`src/shared/quick-open-path-inventory-limits.ts` (26),
`src/shared/workspace-path-search-request-budget.ts` (23) — all three named as dead by the ledger on
2026-10-15 and never removed. Plus `src/shared/skill-freshness.ts` (205): the ledger
(`:1740-1744`) says wire it in or delete it, and nothing on a live path imports it.

---

## 5. P1 detail

### 5.1 i18n fork overlay

**Mechanics (verified).** `verify-localization-catalog.mjs:490-492` reads only `locales/en.json`,
requires every `translate()` key to exist there (`:513`), and `--fix` writes missing keys back
(`:516-520`). `generate-runtime-required-english-catalog.mjs:8-22` derives
`en-runtime-required.json` from it; `i18n.ts:87` ships that as the English boot bundle. The fork has
never modified the scripts — it satisfies the single-source rule by writing 722 keys into upstream's
catalog.

**Design.** `src/renderer/src/i18n/fork/en.json` (outside `locales/`, which `readdir`s every `.json`
as a locale) holds the fork's added and overridden keys;
`src/renderer/src/i18n/fork/en-runtime-required.json` is derived from it. A fork script
`config/scripts/fork-english-catalog.mjs` exports `readEnglishCatalog(root)` (deep merge) and
`writeMissingEnglishEntries(root, entries)` (routes new keys to the overlay). Each upstream read site
becomes a one-line swap: `verify-localization-catalog.mjs:492`, `verify-localization-extraction.mjs:113`,
`localize-renderer-strings.mjs:229-238`, and the runtime-catalog generator (plus one split: overlay
keys go to the fork's derived file). At runtime, one line after init in `i18n.ts`:
`i18n.addResourceBundle('en','translation', forkRuntimeRequired, true, true)`.

**Result.** `en.json` and `en-runtime-required.json` become byte-identical to upstream: −12 and −8
paths per sync. Cost: 4–5 one-line hunks in `config/scripts`, which are moderately hot and a global
gate input. Eight translated keys per non-English locale either fall back to English or ride a
per-locale overlay in the lazy backend's `read`.

**Check first:** `audit-localization-coverage`, `repair-locale-catalog`, `apply-translation-delta`
and `bootstrap-locale-catalog` also read `en.json`; confirm none of them runs in CI.

### 5.2 Stop evicting upstream code

For every file where the fork moved an _upstream_ block out to make room, restore upstream's block
byte-for-byte and keep only the fork hook. Measured headroom (`skipComments`, `skipBlankLines`):

| File                                                                                     | Effective lines | Headroom vs cap                     |
| ---------------------------------------------------------------------------------------- | --------------- | ----------------------------------- |
| `runtime-rpc-client.ts`                                                                  | 292 / 300       | 8 → one import + a 2-line call fits |
| `use-status-bar-controller.ts`                                                           | 280 / 300       | 20                                  |
| `runtime-file-search-client.ts`                                                          | 274 / 300       | 26                                  |
| `tooltip.tsx`                                                                            | 345 / 400       | 55                                  |
| `Landing.tsx`                                                                            | 283 / 400       | 117                                 |
| `DeleteWorktreeDialog.tsx`                                                               | 394 / 400       | 6                                   |
| `update-worktree-meta.ts`, `ai-vault-session-refresh.ts`, `use-app-startup-hydration.ts` | 300 / 300       | 0                                   |

The seven files with headroom are mechanical. The three at exactly 300 need a different remedy:
extract the most _stable_ upstream unit (a type or a constant block with zero upstream commits in 90
days), never the active logic. And when a fork addition genuinely does not fit, move the **fork's**
lines — that is the ledger's own rule (`:768`) and it has not been followed.

Do this per file, each its own commit, each verified by the restored upstream suite. Also worth
upstreaming rather than undoing: `DiffCommentCard` → `useCommentCardResize` (extracted for reuse by
`PRCommentThreadCard.tsx`).

### 5.3 Fork usage providers as data, not if-arms

The fork threads DeepSeek/Fireworks/Copilot through upstream's if-chains across seven status-bar
files (`status-bar-provider-visibility.ts:33-36,50-52,164-171,188-190,249-251,267-269`,
`StatusBarProviderSegment.tsx:200-205`, `tooltip.tsx:127-135`, `usage-error-copy.ts:27-35`, plus an
85-line `icons.tsx` append) and 14 rate-limits files. The ledger calls this "the single most
repeated conflict shape in the repo" (`:256`).

- **Renderer:** `status-bar/fork-usage-providers.tsx` mapping
  `deepseek|fireworks|copilot` → `{label, badgeLetter, Icon, settingsFlag, pendingShape, hasData}`,
  with the icons moved in. Each upstream function keeps one guard line. Fork snapshot/settings fields
  join the upstream type with one `&`. Delete the duplicate `hasUsageData` in
  `StatusBarProviderSegment.tsx`.
- **Main:** use upstream's **existing sibling-provider lane** —
  `service-sibling-provider-result.ts` exports `SettledProviderResult` and
  `settleSiblingProviderResult`, and upstream already runs grok/cursor/zcode/antigravity outside the
  positional tuple. New `rate-limits/fork/fork-provider-cycle.ts` with
  `prepareForkProviderCycle` / `applyForkProviderCycle`; the preparation file gains one import and
  one call and the tuple plus its indentation return to upstream verbatim. Move the `disabled`
  gate from per-call-site ternaries to the resolvers injected by `provider-account-services.ts`,
  applied once in `updateState`; grok/cursor keep one ternary each.

**Two properties need tests:** sibling settle order (the fork chip stops showing "fetching"), and
"a disabled provider never reads its credentials" — assert no resolver call.

No renderer provider registry exists upstream (grep for `Record<UsageProviderId…` returns nothing),
so this is a fork-owned table behind one-line guards until/unless P2.3 lands one.

### 5.4 Dashboard: restore upstream, add a mode

The fork deleted upstream's popout window, drawer, popout bridge, `AgentDashboardSidebarHost.tsx` and
`popout.tsx` (`ab57bb7bbb`, #44) and the ledger records "taken as deletions" (`:529-541`). Upstream
keeps editing those files, so this is 14 modify/delete paths **every sync, forever**.

Restore them byte-identical, extend `AgentDashboardMode = 'in-window' | 'popout'`
(`ui-chrome-types.ts:29`) with `'page'`, and make `'page'` the fork default. That turns 14 conflicts
into one union member plus the page component, and the same change is a plausible upstream proposal
(adds a mode, removes nothing).

Two carry-overs: upstream's `chatNames` change (`3aec926fe5`) also lands in `useLiveDashboardSnapshot.ts`
— keep `chatNames: getStructuredChatTabNames()` in that file's resolution; and widen the ledger's
`Paths` glob to cover `src/renderer/src/popout.tsx` and `sidebar/AgentDashboardSidebarHost.tsx`,
which it currently misses.

### 5.5 TUI config overlay

The fork's `tui-agent-config-table.ts` + `-types.ts` (492 lines) is upstream's 361-line table plus
one entry. Restore upstream's file and change **one** line to
`export const TUI_AGENT_CONFIG = withForkTuiAgentOverrides(Object.fromEntries(…))`, with the overlay
in `tui-agent-config-np.ts`; make one in-place edit
(`if (opts?.isRemote && platform === 'linux')` → `if (opts?.isRemote)`). Net upstream delta: ~2
modified lines, 0 added — so the budget holds. Delete the copy, and check for a path collision with
upstream's own `tui-agent-config-types.ts`. This also removes the ledger's "table edits arrive with
no conflict and must be hand-ported" trap (`:646`).

### 5.6 Small seams

- **`worktree.remove`** — `worktree-remove-method.ts` copies 55 upstream lines to add one
  (`:54`). Pass the flag from `workspace-lifecycle-commands.ts:197` instead; that file is at 185
  lines, so it has room. `worktree.ts` delta → 0.
- **`orcad-entry.ts`** (75 upstream commits/30d, the hottest file in scope) — the fork evicted
  upstream's `prepareOrcadSecretStoreAndMigrate` to buy room for 4 lines of
  `setScreenPromptReader`. Restore it; export `wireScreenPromptReader` from the existing
  `server-screen-prompt-wiring.ts` and call it from both hosts (~291 lines, under budget).
- **`agent-hook-listener.ts`** (298/300) — restore upstream's SessionEnd and inherited-owner blocks;
  move the fork's pre-admit/post-gate into a decorator installed at the listener's construction
  site. The ledger decision "the fork's guards stay" (`:1557`) is unaffected; only their location
  changes.
- **Settings types** — `GlobalSettings` already ends `& NpSettings`; the fork-only fields belong
  there, and upstream's six task-view fields go back into upstream's type. Verify the 299-line
  budget first; if it does not fit, the remedy is P5.2's rule, not moving upstream's fields.

### 5.7 pi: take upstream's fence, restore the roster path

- The fork replaced `omp-session-status-owner-source.ts` with a 204-line module (#68) that decides
  ownership by session file and refuses child sessions; upstream's `f37c1f6b95` (pending in this
  sync) fixes the same bug in 54 lines with a simpler rule (ownership moves only on a
  `session_start` whose reason is `new`, `resume` or `fork`). **Gate:** run the fork's #68 cases
  against upstream's implementation. If they pass, restore upstream's file, delete the fork's, and
  port upstream's 53 new test lines as cases against whichever survives. Until then, keep the fork's
  and reconcile `getOmpSessionOwnerHandlerSourceLines(kind)` at `agent-status-handler-source.ts:6`.
- **Restore the roster at upstream's path and name.** The fork renamed `codex-subagent-roster.ts`
  to `agent-descendant-roster.ts`; upstream still has 7 importers of the old name, so every sync
  brings a modify/delete plus importer rewrites. Put upstream's module back and hang the fork's 186
  lines off it in a sibling.
- `pr-comment-snapshotted-thread-resolver` (#169) and the paste-TTL sweep are product decisions —
  record them in the ledger (they currently are not) and consider asking upstream (P2.3).

### 5.8 Identity

`Orca NP` is permanent fork policy, but its **footprint** is the problem: 55 non-test files carry an
identity literal and **44 of those are upstream-owned**, plus 165 test files. Two changes:

- **electron-builder overlay config.** Upstream already uses the pattern
  (`config/electron-builder-pr-linux.config.cjs` spreads the release config and overrides it). A
  `config/electron-builder.np.config.cjs` overrides `appId`, `productName`, `protocols`,
  `win.executableName`, `extraResources` CLI names, `deb`/`rpm.packageName`, and the build patch's
  `publisherName`/`verifyUpdateCodeSignature`. That removes ~66 changed lines from a
  41-commits/month file and ~89 from its test. `ORCA_MAC_TEAM_ID` is a module constant used inside
  `afterPack`, so it cannot be overridden — the `process.env.APPLE_TEAM_ID ?? …` change is harmless
  upstream and worth contributing.
- **Move the identity literal check out of `package.json`'s `lint` chain.** It is prepended into a
  single line in a file with **100 upstream commits/30 days**; every upstream lint step collides
  with it. Run it from `local/gate-lint.mjs` instead.

Lower the _rename_ cost by having upstream files read the existing constants
(`app-display-name.ts`, `app-directory-names.ts`, `orca-repository.ts`, `orca-cli-command-name.ts`)
rather than literals. Be honest about the trade: converting a literal to an import lowers rename
cost but **not** sync cost — the import line is still a fork hunk. Only an upstream seam removes
that.

### 5.9 Tooling: resolve what can be proven

`LOCAL-PATCHES.md:1207-1213` records that the 10-25 sync resolved 133 hunks by hand under a proof
rule — _upstream never touched the region_ — with a script that was never committed. Commit it,
generalised:

```
conflicts.mjs --propose        # JSON decision file per path/hunk, with the proof it used
conflicts.mjs --apply-proven   # writes only files where EVERY hunk is proven
```

Proof tiers, strongest first: upstream side == base after comment/whitespace strip (take ours);
fork side == base after strip (take theirs); identity-token-only (take theirs, re-run the sweep);
import-only (deduplicated union); `Resolution: delete` in the ledger (propose `git rm`).

Today that is 249 of 336 hunks, fully resolving 164 of 212 files with hunks. Risks and mitigations:
use the repo's own `typescript` scanner rather than a regex, write only fully proven files, and run
`pnpm tc` after.

Two companions, both closing R6:

- **Rename forecast (pre-merge).** Upstream's rename/delete map (old-base..new-base) matched against
  fork-only references — imports, `vi.mock` paths and string paths. Today this names 19 files across
  8 modules _before_ the merge instead of after a 43-minute gate.
- **Fork-symbol survival (post-merge).** Fork-added exports and symbols (old-base..pre-sync-tip)
  absent from the merged tree, fed through `expected-deletions.json`. This generalises the existing
  `deletedForkModules` check from deleted files to modified files — the case that has silently
  dropped fork behaviour at least four times (10-05b, 10-13, 10-15, 10-21).

Also wire in what already exists but is not run: `verify:localization-catalogs` (open follow-up
since 10-16), the full lint chain / `gate-lint.mjs` instead of bare `oxlint`, and
`check-actions-enablement` without `--fix`.

---

## 6. P2 detail

### 6.1 Fork-surface smoke selector

Run the tests the fork's own patches touch (fork-side diff `merge-base..M^1`) plus tests coupled one
import level away, using the existing `branchCoupledPaths` logic. Measured on merge `281cccf5a4`:
954 fork-touched test files, of which 526 in the timing baseline cost 8.8 test-minutes ≈ 5–10 min at
2 workers, against 43 minutes for the full gate. Test-or-sibling matching alone caught 11 of 18
repaired files in the last sync; the import walk closes the rest. This gives the two-tier sync
check the AGENTS.md verification tiers already describe but the repo does not have.

### 6.2 Make the nightly's Linux pass count

Shard reports are already uploaded (14-day retention). A small script can assert that each
Mac-allowlisted test passed on Linux — turning 33 "environment-bound" claims into checks, and
seeding the Linux allowlist the nightly needs before it can be read as a verdict rather than "which
shard". A first agent opening a session after a red nightly triages it (already the AGENTS.md rule).

### 6.3 Upstream-facing PRs — needs a decision

Ranked by "would upstream take it" × "how much divergence it retires". **These are outward-facing
and must not be opened without an explicit ask**:

1. Usage-provider kill-switch (#42, ~1k lines) — generic, and it removes the fork's most repeated
   conflict shape.
2. Copilot usage provider — fits upstream's established provider pattern.
3. AI Vault paging + delta sync (#128) — fixes a real `reply_too_large` failure, opt-in, wire-safe.
4. pi managed-extension mtime fix (#147) — small and generic.
5. Jira transition-field fixes (skip already-filled fields, submit components/versions as `{id}`).
6. Terminal BEL-inside-APC/DCS/PM/SOS fix (`local(terminal)`) — a real bug, one file, cold upstream.
7. `orca-repository` constant (fork PR #146 already built it) and `app-directory-names` with
   upstream's values — pure de-duplication, which upstream's own "Reuse Before Reimplementing" rule
   supports.
8. An identity/brand seam: home directory, app-data name, display name.

### 6.4 Adopt upstream's Claude spend cap

`cffb527b82` (pending) covers the Claude half of `dd1248998f`; take it and keep only the Codex
`spend_control` half (~350 lines removed). Keep #134 (Claude OAuth refresh) as the one permanent
divergence here — upstream deliberately does not refresh (`1bd308bd84`), and the fork's choice is a
product decision. Isolate it in `claude-accounts/claude-oauth-*`.

### 6.5 AI Vault: give the fork its own schema

Fork 6→9 plus upstream 6→8 forced a merged value of 10 (`ledger:1682-1692`), and the same shape
previously hit the parse cache (`:291`). Move the fork's 8 `sessions` columns and `sessions_fts`
into a fork-owned table with its own version key so `SESSION_SEARCH_SCHEMA_VERSION` is upstream's
alone. Separately, the host-leg sync delta belongs in `ai-vault-host-leg-sync.ts` with its own held
lists, wrapping `args.scan` at the `ai-vault.ts` call site, so upstream's cache keeps its original
signature — that is the 8-hunk file. This item is also the strongest upstream candidate (§6.3).

### 6.6 Renderer tidying

- `main.css`'s entire fork delta is one 145-line `.orca-pr-comment-*` block (+31 lines in
  `rich-markdown-editor.css`), and it introduces no tokens, so the styleguide is untouched. Move it
  to a colocated `pr-comment-thread.css` imported by `PRCommentThreadCard.tsx` — upstream already
  does this (`AgentKanbanBoard.tsx:22`). Low payoff (2 of 12 syncs), small effort; verify cascade
  order with a CDP screenshot.
- One `ForkUiSlice` for transient fork state (`settingsProjectAddHostRequest`,
  `prCommentInlineDisplayById`) registered at the existing `store/index.ts:53,144` seam. Leave the
  persisted `hiddenWorkspaceStatusIds` and `mergeSameBranchWorkspaces` alone — they ride upstream's
  hydration.
- `jira/Content.tsx` board-mode state into `use-jira-board-mode.ts`, mounted through one conditional;
  consistent with the ledger's "upstream's shape, the fork's extra capabilities" (`:813`).

### 6.7 Branch base drift

After 10-25 **no branch contains the release tip**; the oldest sit 2,529 commits behind, and
`local/open-pr.mjs` refuses a head that does not descend from its base. With 0 open PRs and ~13
branches, the risk is work rotting rather than conflicting. Policy options, cheapest first:

- **Land or delete.** 6 branches have no own delta or a closed PR; delete them. Several are one
  commit from done (`fix-tag-mirror-token` 1 file +21/−1).
- **Catch up on a schedule, not on demand** — batch all live branches after a sync while the merge's
  resolutions are fresh, rather than one at a time when a PR is wanted.
- **Cap branch age.** A branch older than N syncs gets rebased onto the current tip or dropped.

The tooling already reports this (`node local/branch-status.mjs`); what is missing is a policy that
acts on it, and a recorded "no Orca NP mobile app" decision so `mobile/` work stops accruing.

### 6.8 Gate cost

- 2,575 s against a 3,600 s cap, with a timeout not cached (`gate-verdict-cache.mjs:83`). Investigate
  the doubling (bun 1.4.4 bump, an uncapped run alongside unqueued work, or the mobile install).
- Cache the verdict in the **git common dir** (`--git-common-dir`), not the per-worktree gitdir, so
  the same SHA gated in two worktrees runs once.
- Batch the isolation re-runs: each unexpected file currently gets a serial cold start with a full
  60-minute allowance (`gate-unit.mjs:563-570`).
- Re-check the recorded caveat that the `node-runtime` pool ignores `maxWorkers`. In vitest 5.0.5
  custom poolRunner tasks appear to go through the same queue
  (`node_modules/vitest/dist/chunks/index.1TqnEahn.js:5881,5999,6163`) and both projects share
  `groupOrder: 1`. If the caveat is wrong, capacity planning in AGENTS.md is wrong with it.
- Remove the vitest-direct trap from package scripts (`test:node`, `test:skill-sharing:release` call
  bare `vitest run`, skipping `run-vitest.mjs`'s env). The gate itself is fine; the scripts are what
  produced PR #57's 42 phantom failures.
- `recordDependencies=false` in the gate means a full run never warms Vitest's dependency records,
  so `check:changed` keeps missing its 95% coverage threshold and runs everything.

### 6.9 Retire what the docs describe but the repo does not have

- **`curate.mjs`** plans a curated patch series for the _rebase_ era and counts from
  `git log merge-base..HEAD` without `--first-parent`, so it counts 332 commits including merges and
  its per-group byte-identical promise does not hold on non-linear history. Retire it; do not finish
  it.
- **"Keep rebase for the patch series"** (runbook, `LOCAL-PATCHES.md:1138`) describes a series that
  is not separable: no patch ref exists, the product line imports the identity modules (50 commits),
  and 35 files are shared. Rewrite the wording to match reality.
- **`.husky/commit-msg`** is redundant for upstream PRs (`open-pr.mjs` already refuses `local(`
  commits and fork-owned paths upstream) and counter-productive for fork PRs — it pushed policy work
  through unlabelled PRs at least five times (#146, #130, #142, #177, #52). Either scope it to
  branches that do not descend from `nplez1/main`, or drop it and let policy changes ride fork PRs
  with a `local(` title.

---

## 7. Rejected options (and why)

- **Switch the release line back to rebase.** The merge shape is vindicated by the logs: the dry run
  predicted the exact conflict set six times, no force-pushes, and the semantic breaks people
  attribute to merges appeared identically in the rebase era
  (`sync-log-archive.md:1448,1692`). A rebase would stop once per commit _per collision_ at a 2–3
  day cadence with 150–255 upstream commits/day. Keep merge; add the survival check (§5.9).
- **Move all fork-only files into a fork namespace (`src/fork/**`).** 1,585 paths; the product line's
  own directories already produce 0 conflicts (`workspace-path-index`, `session-summary`, `jenkins`).
  The collisions are at seams, not in directories, and a wholesale move buys churn without removing
  a hunk. Do it per module only where a rename has already broken us.
- **Materialise the patch series as its own branch or patch directory.** Rejected on evidence: the
  product line imports the identity modules, 35 files are shared, a rebased patch branch merged into
  a line holding the old copies pays every conflict twice, and `open-pr.mjs`/the release workflow
  assume ancestry. The measured patch-series conflict load is small (23 of 233 paths, all from one
  comment sweep).
- **A build-time string-rewriting plugin for identity.** Vite `define` replaces identifiers, not
  string literals; the plugin would have to run under vitest too, and it would corrupt prose and the
  deliberately unrenamed names (`orca://`, the relay's plain `orca` shim, per-repo `.orca/`). The
  builder overlay in §5.8 gets most of the benefit for a fraction of the risk.
- **Raise or remove the `max-lines` cap.** It is upstream's own ratchet and a real quality guard.
  The fix is to move the right side's lines (§5.2).
- **Re-seat the PTY suites into the node-runtime project as the known-red fix.** Some entries need
  it (the bun/SQLite class); doing it to the whole class would mask real breakage. Route the 7
  SQLite files, prove the rest with TMPDIR/bash (§6.2).

---

## 8. Success metrics

Record these per sync in the sync log (the tooling can emit them):

| Metric                                                                         | Baseline (2026-10-26)    | Target                    |
| ------------------------------------------------------------------------------ | ------------------------ | ------------------------- |
| Conflicted paths, excluding repo-wide upstream sweeps                          | **70**                   | ≤ 25                      |
| Conflicted paths you must _think_ about (both-rewrote with real upstream work) | ~40                      | ≤ 10                      |
| Follow-up commits per sync                                                     | **~7**                   | ≤ 2                       |
| Silent-breakage files found after the merge                                    | 19 (pending), 30 (10-13) | 0 (forecast before)       |
| Wall clock, pre-sync tip → green                                               | 1–10 h                   | ≤ 2 h                     |
| Known-red entries                                                              | 40                       | ≤ 10, each with a `match` |
| Nightly runs per week                                                          | 0                        | 7                         |
| `en.json` conflicts                                                            | 12/12 syncs              | 0                         |
| Branches containing the release tip                                            | 0 of 13                  | all live branches         |

Measure with the conflict dry run **plus** the per-path upstream-commit classification that
`7d6603aa17` revealed — a raw path count is not the metric, because one upstream sweep can triple it.

---

## 9. Sequencing

**Week 1 (~1 day of work):** P0.1–P0.9. These are independent, individually revertible, and they
pay for themselves by the next sync. P0.1 and P0.2 first — they protect everything else.

**Weeks 2–4:** P1.1 (i18n) and P1.8 (identity) first, because they remove the two highest-recurrence
artefacts; then P1.2 (restore evicted blocks) and P1.3 (usage providers), which are the two biggest
recurring shapes; then P1.4–P1.7 as capacity allows. Every P1 item is its own PR-sized change with
its own restored or fork-owned tests.

**Ongoing:** P2. P2.3 (upstream PRs) needs an explicit decision before anything is opened.
P2.1 depends on P1.9.

Nothing in this plan requires a change to the sync shape, the branch topology or the release
process. That is deliberate: those are load-bearing and the evidence does not say they are wrong.

---

## Appendix — how this was measured

```bash
# the conflict set, dry run, no working tree touched
node local/sync/conflicts.mjs --merge-tree HEAD upstream/main --json > /tmp/conflicts.json

# which conflicts are real upstream work vs one repo-wide sweep
for p in $(jq -r '.files[].path' /tmp/conflicts.json); do
  git log --format=%h 0571e45107..upstream/main -- "$p"
done

# fork footprint and silent rename breakage
comm -23 <(git ls-tree -r --name-only HEAD | sort) \
         <(git ls-tree -r --name-only upstream/main | sort)
git diff -M --name-status 0571e45107 upstream/main | awk '$1 ~ /^R/'

# known-red and gate behaviour
jq '.entries | length' local/unit-known-red.json
gh run list --workflow fork-main-tests.yml --repo nplez1/orca -L 5
```

Confidence: every figure in §1 is from the commands above or from `git`/`gh` output taken on
2026-10-26. The per-item "removes N" estimates are estimates — they were not replayed as merges —
and the items marked _check first_ are the ones whose feasibility still depends on a read that has
not been done.
