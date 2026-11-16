# `local/sync/` — the tooling behind an upstream sync

Small `node` scripts, one markdown ledger, and the prompt templates a sync's subagents run from.
Nothing here resolves a conflict for you; they exist so a sync starts informed, a conflict stop is cheap to classify, and the checks that caught
real breakage are one command instead of a list you read off a runbook at the end.

The process they belong to is [UPSTREAM-SYNC-RUNBOOK.md](../../UPSTREAM-SYNC-RUNBOOK.md).

| Tool                    | Use it when                                    | Mutates anything?                                                                                                              |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pre-sync.mjs`          | before starting a sync                         | refs and git config only with `--prepare`; the catalog gate rewrites the derived catalog                                       |
| `conflicts.mjs`         | stopped in a conflict, or to predict one       | no                                                                                                                             |
| `post-sync.mjs`         | the tree is resolved and you are about to push | the catalog check rewrites the derived catalog (that rewriting _is_ the check); its report and row caches go under the git dir |
| `identity-sweep.mjs`    | any time the tree is not conflicted            | only with `--fix`                                                                                                              |
| `fork-symbols.mjs`      | after the merge, beside post-sync              | no                                                                                                                             |
| `linux-lane.mjs`        | post-sync and `pnpm tc` pass; again at the end | pushes a `sync-candidate/<sha12>` ref and dispatches `fork-main-tests.yml` on it                                               |
| `convergence-ledger.md` | every time a convergence question comes up     | edit it when you settle one                                                                                                    |

**Neither sync script is read-only.** `pre-sync.mjs` and `post-sync.mjs` both run
`pnpm run sync:localization-runtime-catalog`, which rewrites the derived catalog with `--fix`; that
the rewrite produces no diff _is_ the check. `pre-sync.mjs --prepare` is the only path that moves a
ref or writes git config.

## The flow

```bash
# 0. gate and prepare
git fetch origin && git fetch upstream
node local/sync/pre-sync.mjs --prepare

# 1. sync the release line (merge) or a feature branch (rebase; there is no patch series)
git merge upstream/main

# 2. work the conflicts
node local/sync/conflicts.mjs --summary
node local/sync/conflicts.mjs            # per file: stages, balance, class, ledger entries

# 3. prove it
node local/sync/post-sync.mjs

# 3.5 the release's Linux unit lane, on a candidate ref, while the local gates run
node local/sync/linux-lane.mjs           # --dry-run first; --cleanup after the release

# 4. publish
node local/sync/publish-sync.mjs         # push origin main, then sweep the Actions fleet
```

## The templates

A sync and release is run by one agent that fans work out to subagents. The prompts it hands them are
checked in under [`templates/`](./templates/), parameterised with `{{PLACEHOLDERS}}` that each file's
header comment lists. Fill them, and check nothing still reads `{{`, before sending.

| Template                    | Who gets it                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `release-brief.md`          | the release agent itself — **start a sync and release with this brief**             |
| `conflict-protocol.md`      | written once per sync to `<git-dir>/orca-sync/PROTOCOL.md`; every resolver reads it |
| `resolve-batch.md`          | one resolver per batch of at most 20 conflicted paths                               |
| `repair-typecheck.md`       | one fixer per TypeScript project after the merge                                    |
| `repair-tests.md`           | unit-gate or Linux-lane reds, grouped by area                                       |
| `repair-lint.md`            | lint-gate steps, disjoint sets per fixer                                            |
| `repair-review-findings.md` | the findings of RELEASE-RUNBOOK.md Step 1.6, grouped by area                        |

The brief names runbook steps rather than copying their commands, so a runbook change reaches it
without an edit. Its "Orchestration" section holds the rules the 2026-11-15 run paid for: batch size,
file-by-file staging, no repo-wide commands in a resolver, waiting on the harness instead of `sleep`,
and one runner per heavy gate.

## What each one is for

**`pre-sync.mjs`** — the gate whose absence made the 2026-10-05 sync expensive. It refuses to start
on a dirty tree or a tip that does not typecheck, regenerates the derived localization catalog, checks
that `local(` commits are only on `main`, verifies the local branch's relationship to
`origin/main` (equal / ahead / behind / diverged, failing on behind or diverged), sets
`rerere` and `zdiff3`, records the old base / local tip / new base, and prints the conflict set a merge
would present plus the next step (merge by default, rebase with `--rebase`). `--prepare` is
idempotent: a rerun never overwrites `backup/nplez1-main-pre-sync`, and a backup that has drifted off
the pre-sync tip is reported as a failure rather than passing silently. The backup ref keeps its
pre-rename name because existing refs are named that.

**`conflicts.mjs`** — the tool that replaced a throwaway script run ~20 times by hand. For every
conflicted path it prints the three merge stages, each side's delimiter balance, the added/removed
counts, a classification (`union`, `duplicate-tail`, `both-rewrote`, `add/add`, `rename-replay`,
`duplicate-members`, `modify/delete`) and the ledger entries whose paths match. `--merge-tree <base>
<other>` does the same for a conflict that does not exist yet. **Every classification is a hint**:
delimiter balance cannot prove a union is correct.

`--propose` also attaches a per-hunk proof read from each side's syntax tree (via `typescript-api`,
the 6.x JS API; the `typescript` dependency is the native TS 7 compiler and has none):
upstream-unchanged (take ours), fork-unchanged (take theirs), identity-only (theirs with the fork's
literals re-applied), import-only (three-way union). A proven file must also pass a whole-file gate
(`lib/conflict-file-gate.mjs`), because no tier can see the tree, git's clean merge, or another file:

- every relative, `@/`/`@renderer/` (resolved per project: `mobile/` and `docs/site/` map `@/` to
  their own `src/`), `@orca/` workspace and `new URL(…, import.meta.url)` path names a file the index
  keeps — stage 0, or both sides' stages; a modify/delete is undecided. A TS importer probes like the
  compiler (never a `.d.ts` for a value import); a JS importer and a URL need the exact path;
- it imports or re-exports nothing an index stage removed, and uses no name base imported that it
  neither imports nor declares at module scope (a text scan: an inner parameter of the same name does
  not count, and a shadowed use is a false hit, which only refuses);
- a binding a side re-pointed at another module keeps the other side's edits
  (`lib/conflict-provider-gate.mjs`). It passes when the new module is the old one moved and the
  index holds the merge's own three-way result of that move, or when the other side changed nothing,
  byte for byte, in the old module and everything it imports. Anything it cannot trace refuses: an
  `@orca/` import in the closure, a path base cannot resolve, a merge with more than one merge base.

`--apply-proven <decision.json>` refuses a decision proposed for another operation (merge head, HEAD,
rebase step), re-proves each file from disk and writes only files where every hunk is proven and
nothing changed since the proposal. A rerun runs what an earlier run wrote back through the whole-file
gate against the live index and reports it as `already` (the hunks are not re-proved: their markers
are gone). A path that is no longer unmerged — staged, by hand or after review — has no stages left,
so it is reported as `staged`, is neither written nor re-checked, and does not fail the run: a partial
`git add` followed by a rerun exits 0 and still writes every other proven file. It stages nothing and prints, never runs, the `git rm` a settled deletion needs. `--rename-forecast
<old-base> <new-base>` runs before the merge and lists fork-added references (imports, `vi.mock`, path
strings) that upstream's renames and deletions will leave pointing at nothing.

**Replay evidence, 2026-11-15** (`a992b134ffe` + `1ce376b27e3`, 694 conflicted paths, compared with the
merge that shipped, `7da96c11bd4`). Before the gate, 189 files were written and 88 of them differed
from the merge: 54 stale module paths, 29 import unions that kept a binding one side had dropped, 4
orphaned imports from git's clean merge, and `WorktreeCardStatusSlot.tsx`, which took upstream's
`import type { WorktreeStatus }` from the shared rollup module while the fork had added `'setup'` to
the renderer's own `WorktreeStatus` — `tsc` reports four errors with it in place of the merge's line.
Now 84 are written, all byte-identical to `7da96c11bd4`; 610 are left manual and none is refused.
Comparing the whole old module and its import closure, instead of the binding's declaration, cost 16
written files that turned out right. The check refuses 18 files in all — `WorktreeCardStatusSlot.tsx`
and `session-scanner-primary-parsers.ts`, correct in the merge only because the fork's
`parseJsonObject` change was re-homed by hand, among them: in 12 the other side had edited something in
the old module's closure, in 6 the closure could not be traced (an `@orca/` package, or a path base
cannot resolve). That is the price of not tracing re-exports, aliases and dependencies by hand.
`--propose` took 34 s, of which `git diff -M -l0` is 5.3 s on upstream's 7,872 renames (0.05 s on the
fork's one); the default rename limit stopped pairing at 6,940.

**What the gate does not check**, so a written file can still be wrong in these ways: bare package
specifiers (a removed dependency), `import.meta.glob` patterns, JSDoc `import()` types, `declare
module` names, paths inside JSON or other string literals (`path.join(__dirname, '../x')`), template
specifiers with substitutions, whether a resolved module still exports the imported name, and a
binding imported from a module no side re-pointed whose declaration the other side changed (a
cross-file semantic conflict git merges cleanly). Typecheck is still the gate after the merge.

The two mistakes it is designed to prevent, both made for real:

- duplicating a shared tail when the tail already closed _both_ sides (that one shipped a doubled
  `]`);
- a union that repeats a member both sides already had (duplicate `Object.assign` members, duplicate
  `Map` entries, a missing comma).

**`post-sync.mjs`** — the integration checks, grouped and machine-checkable: conflict markers, the
identity sweep, the derived catalogs and both localization verifiers, the locale catalogs
(`localeDrift`: upstream owns `i18n/locales/` byte-for-byte, so any diff there is conflict adjacency),
the builder config, the update-feed anchors and the whole `src/main/updater/` tree, every test path and
package script `LOCAL-PATCHES.md` cites (`citedGuards`), the lost-content diff, the exported surface of
every deleted fork-only module (each name searched for a surviving reference — a deleted module is
invisible to a modified-files diff), the fork-modified test files the sync left gone
(`upstreamDeletedForkTests`, baselined per sync range) and the fork-added test cases in no test file
at HEAD (same row and baseline, acknowledged per case), the fork-added names a merged file no longer
declares (`forkSymbolSurvival`, so `fork-symbols.mjs` below runs as one row of this command rather than
as a step somebody has to remember), fork-added module specifiers that resolve to nothing at HEAD, every Swift target under `native/`
compiling, and `pnpm tc`. Every run saves its report to `<git-dir>/orca-sync/post-sync-last.txt`
(and `.json`): read that rather than re-running, and re-check one row with `--only <id>`. A partial run
never retires the state file, and the typecheck and native rows cache a PASS per exact content. "Skipped" and "unavailable"
are reported as themselves; `unavailable` fails the run unless `--waive <id>:<reason>` records why, and
the waiver is printed. A clean run deletes the pre-sync state file, and the tip and base every range
check uses are checked against HEAD's own parents first (`lib/sync-range.mjs`).

**`fork-symbols.mjs`** — the modified-file companion to post-sync's deleted-module row: names the
fork added to a file since the old base (top-level declarations, and members of top-level classes,
interfaces, type literals, enums and object-literal constants, arrow and call bodies, `export default`
objects and nested literals) that the merged file no longer declares. It runs as post-sync's
`fork-symbol-survival` row; run it alone to see why a row named a symbol. A `symbols` entry in
`expected-deletions.json` with status `expected-deletion` acknowledges one.

It exits **1 whenever any name is relocated or lost**, so a relocation needs an acknowledgement too; the
summary reports both. The `merged` ref must contain the pre-sync tip and the new upstream base
(`merge-base --is-ancestor` against the merged ref, once per ref — not a bidirectional test between the
two), and it fails closed otherwise — during conflict resolution `HEAD`
is still the tip, so the default would otherwise compare the tip with itself and report clear.

**`identity-sweep.mjs`** — upstream reintroduces `~/.orca`, `orca.exe` and `orca-dev` every sync.
This reports them against a documented allowlist (the `orca://` scheme, the relay's fixed shim, the
legacy daemon exe name) and fixes only the mechanical literal cases. Persisted-path changes are
report-only until the `~/.orca` migration is designed — and `identity-sweep-baseline.json` freezes
which report-only findings already exist, per rule and per file, so post-sync's row fails on a new one
instead of passing on `fixable === 0`. `--baseline-init [--accept <reason>]` and `--baseline-prune`
move it, and the total may only shrink.

**`linux-lane.mjs`** — runs the release workflow's Linux unit lane early. It pushes HEAD to
`sync-candidate/<sha12>` (a new ref per revision, never a force-push) and dispatches
`fork-main-tests.yml` on it, which runs that ref's own copy of the workflow, shard plan and Linux
known-red list. Before pushing it reads every workflow file in the candidate's tree and refuses if a
`push` or `create` trigger would fire for that ref, or if the lane can reach a runner label this fork
does not provision. `--cleanup` deletes the candidate refs `origin/main` already contains and names the
rest. UPSTREAM-SYNC-RUNBOOK.md Step 3.5 is why it exists.

**`curate.mjs`** — **retired 2026-10-27.** It planned a curated, linear patch series for the _rebase_
era: a contiguous partition of the release line where each patch's tree is a real historical tree. It
counted from `git log merge-base..HEAD` without `--first-parent`, so it counted 332 commits including
merges, and its per-group byte-identical promise does not hold on non-linear history. It was never
applied. The series it planned does not exist as a separable thing, so finishing the tool would have
bought a plan for a branch nobody can build.

**`convergence-ledger.md`** — the reason a decision does not have to be made twice. `rerere` reuses
textual conflict shapes; it cannot remember that upstream's key-store factory beat ours, or that the
floating workspace stays in `~/.orca-np`. Add an entry whenever a sync settles a question, and delete
one when upstream supersedes it.
