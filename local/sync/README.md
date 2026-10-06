# `local/sync/` — the tooling behind an upstream sync

Five small `node` scripts and one markdown ledger. Nothing here resolves a conflict for you; they
exist so a sync starts informed, a conflict stop is cheap to classify, and the checks that caught
real breakage are one command instead of a list you read off a runbook at the end.

The process they belong to is [UPSTREAM-SYNC-RUNBOOK.md](../../UPSTREAM-SYNC-RUNBOOK.md).

| Tool                    | Use it when                                             | Mutates anything?                                                                        |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pre-sync.mjs`          | before starting a sync                                  | refs and git config only with `--prepare`; the catalog gate rewrites the derived catalog |
| `conflicts.mjs`         | stopped in a conflict, or to predict one                | no                                                                                       |
| `post-sync.mjs`         | the tree is resolved and you are about to push          | the catalog check rewrites the derived catalog (that rewriting _is_ the check)           |
| `identity-sweep.mjs`    | any time the tree is not conflicted                     | only with `--fix`                                                                        |
| `curate.mjs`            | you want a plan for collapsing `docs(fork)` bookkeeping | `--write-manifest` writes `local/sync/patch-series.json`; never builds a branch          |
| `convergence-ledger.md` | every time a convergence question comes up              | edit it when you settle one                                                              |

**Neither sync script is read-only.** `pre-sync.mjs` and `post-sync.mjs` both run
`pnpm run sync:localization-runtime-catalog`, which rewrites the derived catalog with `--fix`; that
the rewrite produces no diff _is_ the check. `pre-sync.mjs --prepare` is the only path that moves a
ref or writes git config.

## The flow

```bash
# 0. gate and prepare
git fetch origin && git fetch upstream
node local/sync/pre-sync.mjs --prepare

# 1. sync the release line (merges) or a feature branch / patch series (rebase)
git merge upstream/main

# 2. work the conflicts
node local/sync/conflicts.mjs --summary
node local/sync/conflicts.mjs            # per file: stages, balance, class, ledger entries

# 3. prove it
node local/sync/post-sync.mjs

# 4. publish
git push origin upstream/main:main && git push origin nplez1/main
```

## What each one is for

**`pre-sync.mjs`** — the gate whose absence made the 2026-10-05 sync expensive. It refuses to start
on a dirty tree or a tip that does not typecheck, regenerates the derived localization catalog, checks
that `local(` commits are only on `nplez1/main`, verifies the local branch's relationship to
`origin/nplez1/main` (equal / ahead / behind / diverged, failing on behind or diverged), sets
`rerere` and `zdiff3`, records the old base / local tip / new base, and prints the conflict set a merge
would present plus the next step (merge by default, rebase with `--rebase`). `--prepare` is
idempotent: a rerun never overwrites `backup/nplez1-main-pre-sync`, and a backup that has drifted off
the pre-sync tip is reported as a failure rather than passing silently.

**`conflicts.mjs`** — the tool that replaced a throwaway script run ~20 times by hand. For every
conflicted path it prints the three merge stages, each side's delimiter balance, the added/removed
counts, a classification (`union`, `duplicate-tail`, `both-rewrote`, `add/add`, `rename-replay`,
`duplicate-members`, `modify/delete`) and the ledger entries whose paths match. `--merge-tree <base>
<other>` does the same for a conflict that does not exist yet. **Every classification is a hint**:
delimiter balance cannot prove a union is correct.

The two mistakes it is designed to prevent, both made for real:

- duplicating a shared tail when the tail already closed _both_ sides (that one shipped a doubled
  `]`);
- a union that repeats a member both sides already had (duplicate `Object.assign` members, duplicate
  `Map` entries, a missing comma).

**`post-sync.mjs`** — the integration checks, grouped and machine-checkable: conflict markers, the
identity sweep, the derived catalogs and both localization verifiers, the builder config, the
update-feed references, the lost-content diff, the exported surface of every deleted fork-only
module (each name searched for a surviving reference — a deleted module is invisible to a
modified-files diff), and `pnpm tc`. "Skipped" and "unavailable" are reported as themselves, never
as a pass.

**`identity-sweep.mjs`** — upstream reintroduces `~/.orca`, `orca.exe` and `orca-dev` every sync.
This reports them against a documented allowlist (the `orca://` scheme, the relay's fixed shim, the
legacy daemon exe name) and fixes only the mechanical literal cases. Persisted-path changes are
report-only until the `~/.orca` migration is designed.

**`curate.mjs`** — plans a curated, linear patch series: a contiguous partition of the existing line,
where each patch's tree is a real historical tree, so a series built from the plan ends byte-identical
and nothing can change behaviourally. `--plan` prints the partition and `--write-manifest` records it;
applying it is a manual, reviewed operation, because building the branch would overwrite an existing
`nplez1/curated` and every commit it made would go through the commit hooks. Folding is limited to
`docs(fork)` bookkeeping; `fix(sync)` is reported as its own bucket and never folded — `0ca31372cc`
restored authorization behaviour across 14 files. It was **not** applied on 2026-10-05, because the
gain measured ~15 fewer patches out of ~148 in exchange for a second public rewrite of the release
line. Prefer it only when the bookkeeping has accumulated again.

**`convergence-ledger.md`** — the reason a decision does not have to be made twice. `rerere` reuses
textual conflict shapes; it cannot remember that upstream's key-store factory beat ours, or that the
floating workspace stays in `~/.orca-np`. Add an entry whenever a sync settles a question, and delete
one when upstream supersedes it.
