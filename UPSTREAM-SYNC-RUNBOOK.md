# Upstream sync runbook

How to bring `nplez1/main` up to upstream `main` and publish a release from it. The short
instruction is **"sync upstream"**; everything below is what that means.

Companions: [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) for the patch series that must survive,
[BRANCHES.md](./BRANCHES.md) for what each branch is, [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md)
for publishing, [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) for the
decisions already made, and [local/sync/README.md](./local/sync/README.md) for the tools.

## Two shapes, one decision

This fork carries two different kinds of content on one branch:

- **A product line** — its own features and fixes (PRs #17–#51), ~100 of the 148 commits in the
  2026-10-05 sync. This is what collides with upstream, because it touches the same hot files
  upstream keeps editing.
- **A patch series** — the `local(...)` commits (identity, updater, CI, build, hooks, docs, vm,
  skills, terminal, agents). Small, self-contained, and genuinely fork-only.

For years every sync rebased *both*. That is where the cost comes from: a rebase pays once per commit
*per collision*, so `service-full-cycle-preparation.ts` — seven fork commits, all touching a file
upstream also changed — stopped the 2026-10-05 rebase three separate times, re-deciding the same
thing each time.

**Decision (2026-10-05): merge upstream into the release line; keep rebase for the patch series and
for feature branches.** The deciding cost is repeated resolution, not a measured speedup:

- A rebase stops once per commit *per collision*, so the same file stops it several times and each
  stop re-decides a question already settled.
- A merge presents one conflict set for the whole pending delta, resolved once per file. On the
  50-commit delta pending at that date, `node local/sync/conflicts.mjs --merge-tree <old-tip>
  upstream/main --summary` lists **26 conflicted paths** (68 files auto-merge), and there is one tree
  to verify and no force-push.
- The "~20 stops" figure that used to appear here came from the preceding, much larger sync (505
  upstream commits). It is **not** a measurement of that 50-commit delta and is not used as one.

What a merge gives up, and what replaces it:

- `git range-diff` over the whole line: replaced by `git show --remerge-diff` (per-merge resolution
  review), the endpoint-delta review below, and the tests. **Keep `range-diff` for the patch series
  and for feature branches**, which are still rebased.
- The pre-sync-tip lost-content diff still works, and still matters (see Step 3).
- Force-push: no longer needed for the release line, so `backup/` refs stop being load-bearing
  there.

Still true either way, so do not "fix" these:

- `.husky/commit-msg` refuses `local(` commits anywhere but `nplez1/main`. Do not bypass it.
- `.github/workflows/fork-release.yml` stamps `<package.json version>-np.${GITHUB_RUN_NUMBER}` —
  history shape is irrelevant to versioning.
- `local/open-pr.mjs` requires a PR head to descend from its base, and the base must be an ancestor
  of the head *as it stands now*. A merge line preserves ancestry; a stale PR head does not, so a
  branch cut before any sync needs its own catch-up before it can be opened.

## The tools

Everything below is a plain `node local/sync/...` script. They are advisory: none of them resolves
a conflict for you.

```bash
node local/sync/pre-sync.mjs [--prepare] [--json] [--skip-typecheck]
node local/sync/conflicts.mjs [--summary|--json|--verify]
node local/sync/conflicts.mjs --merge-tree <base> <other>      # dry run, no working tree touched
node local/sync/post-sync.mjs [--json] [--skip-typecheck]
node local/sync/identity-sweep.mjs [--json|--fix]
node local/sync/curate.mjs --plan | --write-manifest                # plan a curated patch series; never builds a branch
```

`local/sync/convergence-ledger.md` is not a script: it is the durable record of *which side wins*
per subsystem, seeded from the decisions of every sync so far. `conflicts.mjs` prints the entries
matching each conflicted path, which is what stops the same convergence question being re-litigated
every few months.

## Step 0 — pre-flight

```bash
git fetch origin && git fetch upstream
node local/sync/pre-sync.mjs --prepare
```

`--prepare` is idempotent and refuses to clobber an existing backup. It checks the things that made
the 2026-10-05 sync expensive to diagnose: a clean tree (nothing here is safe to sync dirty), no
stray conflict markers, **the tip typechecks before you start**, the derived localization catalog
regenerating to no diff, `local(` commits confined to `nplez1/main`, `rerere.enabled` +
`merge.conflictStyle zdiff3`, and it records old base / old tip / new base plus the dry-run conflict
set. Nothing on the remote changes until Step 4.

## Step 1 — the sync

**Release line (default):**

```bash
git checkout nplez1/main
git merge upstream/main          # one conflict set, resolved once per file
```

**Patch series and feature branches (rebase):** a fork PR branch is cut from `nplez1/main`, which is
the base `local/open-pr.mjs` requires; only an **upstream-bound** branch is cut from `origin/main`.
Either way, rebase `--onto` the new base. Replay order is by commit date, so a commit that arrived
through a merge can land after the commits that refined it. That is expected; see the traps in
Step 2.

```bash
GIT_EDITOR=true git rebase upstream/main
```

## Step 2 — resolve conflicts

```bash
node local/sync/conflicts.mjs --summary     # what is conflicted, by class
node local/sync/conflicts.mjs               # per-file, per-hunk: stages, balance, class, ledger entries
```

Then work the file. The three index stages are the ground truth, not the markers, and they exist in
both shapes:

```bash
f=src/main/ipc/ai-vault-search.ts
for s in 1 2 3; do git show ":$s:$f" > /tmp/$s.ts; done   # 1=base 2=ours 3=theirs
```

**In a rebase**, `:2:` (`ours`) is the new base — upstream's line — and `:3:` (`theirs`) is the commit
being replayed. Stage 1 is that commit's own old parent, so `1 → 3` is the commit's own delta and is
what has to be re-applied onto `:2:`. Resolve, `git add`, then `GIT_EDITOR=true git rebase
--continue`.

**In a merge**, it is the other way round: `:2:` (`ours`) is our line, `:3:` (`theirs`) is upstream,
and `:1:` is the common ancestor. Stage 3 is the incoming upstream file, and the resolution for the
*merged* tree is what you stage with `git add` before `git merge --continue`.

**`--ours` / `--theirs` name the opposite pair of sides in a merge than in a rebase.** In a merge
`--ours` is our line and `--theirs` is upstream; in a rebase `--ours` is the base being rebased onto
(upstream's line) and `--theirs` is the commit being replayed. That inversion is expensive when it is
missed, so resolve from the stages above rather than from the flags.

Stages survive until you `git add`, so this works at any point in either operation.

**Classify every conflict, and stop on the substantial ones.**

- **Trivial / mechanical** — resolve and keep going: both sides appended to the same list or import
  block; both added a member to the same union; a rename replay landing on a file upstream kept
  editing; an import line in a test. Check the union for **duplicate members** — plain
  concatenation repeats what both sides already had, and that has produced duplicate `Object.assign`
  members, duplicate `Map` entries and a missing comma. `conflicts.mjs` reports a
  `duplicate-members` hunk for the shapes it can see (indented `key: value`, `x.set(key, ...)`, a
  one-per-line quoted union entry); it cannot see every list shape, so read the union too.
- **Substantial — stop and report before resolving.** Signals:
  - upstream rewrote the same function or file we did;
  - an add/add collision on a file _we_ also introduced (two independent implementations of one
    idea);
  - the other side is not upstream at all but our own older variant, because a linear rebase
    flattened a hand-resolved merge;
  - the fix upstream landed is a superset of ours ⇒ **drop our commit** (`git rebase --skip`, or
    take upstream's file in a merge) and say so in the sync log.

When upstream has built the same thing, ask the fork's owner which way to converge, then **write the
answer into the ledger** in the same commit. Decisions already taken are in
[local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md).

### Traps, all of them hit for real

1. **A rebase drops merge commits, and a hand-resolved merge's content exists only in the merge
   commit.** `b1daf0ca58` had resolved six things by hand (the grok/copilot union in
   listener-state.ts, `workingMode: 'monitoring'`, the pi `pi.events` binding, the legacy-adapter
   test helpers, duplicated `StopCancelled` entries). A linear rebase replays only the parents, so
   all of it vanished, and later commits then _looked_ like they were removing features. Step 3's
   pre-sync-tip diff is what catches this; resolve any file it flags by taking the old tip's
   content. This trap is a large part of why the release line now merges.
2. **A skipped commit may carry more than the one thing upstream superseded.** We skipped
   `ae84a327e7` because upstream had implemented its grok half; it also carried the child-waiting
   fact, the pane-visible assertions and the `StopCancelled` de-duplication. Restore what upstream
   does _not_ supersede before continuing.
3. **Renames replay onto files upstream is still editing.** `codex-subagent-roster` →
   `agent-descendant-roster`: apply the rename mapping to upstream's version, longest identifiers
   first (`getOrCreateCodexSubagentRoster` before `CodexSubagentRoster`). The identity rename is
   the same trap in a different costume, and upstream adds new violations every sync — run
   `node local/sync/identity-sweep.mjs` once the tree is not conflicted.
4. **Derived files are regenerated, not merged.** For
   `src/renderer/src/i18n/en-runtime-required.json` (and any locale conflict): union the source
   catalog by hand, then `pnpm run sync:localization-runtime-catalog`. Never hand-merge the derived
   file.
5. **A clean merge is not a correct merge.** Real breaks that never conflicted: a writer's
   `storeContent` early return calling `discard()` (a metadata-only index then wrote no session
   row); upstream's per-host `enabled` toggle writing a settings field the fork had renamed to
   `contentEnabled` (a no-op toggle); two settings surfaces controlling one consent. Step 3's
   typecheck and tests are what find these — and with a merge there is exactly one tree to run them
   on.
6. **The commit-msg hook refuses `local(` commits anywhere but `nplez1/main`.** Sync on the branch
   itself; do not bypass the hook.
7. **Reword a commit whose body no longer describes its content** (ours described the engine we
   dropped). **Rebases only:** fold the doc fix in with `git rebase -i <sha>^`, mark it `edit`, amend,
   continue. The merge release line has no linear series to reword; there, amend the merge commit or
   land a follow-up commit.
8. **Both sides can pick the same persisted-format version for different reasons**, and the two
   lineages can already **share** a number. Since schema 2 the `appVersion` equality gate is gone, so
   the version number is the _only_ compatibility signal, and a collision is not detectable any other
   way — upstream's own test for its bump writes the previous version, so it cannot see the fork's
   copy. **When both sides bump a persisted-format version in one sync, the merged file takes a
   version strictly above every version either side has shipped** — not merely the higher of the two,
   because the two lines have already meant the same number before (both sides meant 4, then both
   meant 5), and a released build is out there writing that number.
9. **`git merge-tree` prints its informational messages on stdout in this git version.** A naive
   `2>&1 | tail -n +2` counts `Auto-merging` lines as conflicted paths, which inflated one dry run
   from 95 files to 481. Read the `CONFLICT` lines deliberately; `conflicts.mjs --merge-tree` does.
10. **A red the next commit owns is expected, and is not a finding.** Commits in this fork's series
    have shipped a syntax error a later commit fixes (a half-applied edit, a displaced comma, a
    doubled `]`) and test mocks that lag the commit adding them. In a *rebase*, treat such a red as
    transient only after checking that a later commit in the range owns it (`git log -S`, or the
    file at the tip) — and never chase it, because fixing it mid-series conflicts with the commit
    that owns the fix. In a *merge* there is no such class: every red is real. This is the single
    biggest reason a mid-sync `pnpm tc` was unusable during the 2026-10-05 rebase.
11. **Upstream can move while you are syncing.** It advanced 50 commits during the 2026-10-05 sync.
    Record the base you actually rebased onto, re-fetch before pushing, and expect the next sync to
    start from wherever upstream is then — not from the base you used.

## Step 3 — verify, in this order

```bash
node local/sync/post-sync.mjs
```

That runs the integration checks in one pass: conflict markers, the fork identity sweep, the
derived catalogs (regenerate + both localization verifiers), the builder config loading, the five
update-feed references still naming `nplez1/orca`, the lost-content diff, and `pnpm tc`. For a
**rebase**, also run the patch review:

```bash
# Nothing of ours was silently lost. A MODIFIED file upstream never touched is a red flag
# (unless it is fork-only by construction: the path does not exist upstream).
git range-diff --no-patch <old-base>..<pre-sync-tip> <new-base>..HEAD

# The local() series, patch by patch. With a curated series this is ~25 patches, not ~150.
git log --oneline <new-base>..HEAD --grep '^local('
```

For a **merge**, review the resolution instead of the replay:

```bash
git show --remerge-diff <merge-commit>        # exactly what the merge chose, per hunk
git diff <pre-sync-tip> HEAD --stat           # the endpoint delta: upstream content + resolutions
```

Then the gates that no script can judge:

- `pnpm tc` — the strongest single signal; it found both semantic breaks of the 2026-10-05 sync that
  no conflict marker showed.
- `pnpm test <every test file in a touched area>`.
- `pnpm run check:code-quality:changed` (against `upstream/main` for a sync-sized change). Findings
  in fork-only files are expected debt; a finding in a file this sync touched is not.

## Step 4 — push

```bash
git push origin upstream/main:main          # the upstream mirror; only upstream-bound branches are cut from it
git push origin nplez1/main                 # a merge line fast-forwards; no force needed
```

A rebased patch series or feature branch still needs `--force-with-lease`. Keep
`backup/nplez1-main-pre-sync` until a release has shipped from the new line.

## Step 5 — record it

- **LOCAL-PATCHES.md § Sync log** — base SHA, upstream commits, which patches needed resolution,
  what was dropped, what diverged deliberately.
- **local/sync/convergence-ledger.md** — every decision this sync settled, in the subsystem section
  it belongs to. This is the file that makes the next sync cheaper; a decision left only in the sync
  log gets re-litigated.
- **BRANCHES.md** — the "Last updated" line and which PR branches now sit on an older base.
- Anything left open, as a named follow-up rather than a TODO in a file.

## Step 6 — release

`gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main`, then follow
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md). The version stamps itself as
`<package.json version>-np.<run number>`, so no number is chosen by hand.
