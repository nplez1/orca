# Upstream sync runbook

How to bring `nplez1/main` up to upstream `main` and publish a release from it. The short
instruction is **"rebase upstream main"**; everything below is what that means.

Companions: [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) for the patch series that must survive,
[BRANCHES.md](./BRANCHES.md) for what each branch is, [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md)
for publishing after the sync.

## Why a rebase and not a merge

`nplez1/main` is a patch series on top of upstream, and every fork sync so far was a rebase onto
upstream's tip: `POST /repos/{owner}/{repo}/releases`-style feeds, the `local(...)` patches and the
`range-diff` verification all assume a linear series. A merge commit would make the next sync's
`git rebase origin/main` replay a merge, and `range-diff` could no longer show each patch unchanged.

## Step 0 — gather state (read-only)

```bash
git fetch origin && git fetch upstream
git status --porcelain=v1            # must be empty; nothing here is safe to rebase dirty
git rev-list --left-right --count origin/nplez1/main...HEAD
```

Record three SHAs before touching anything:

- **old base** = `git merge-base origin/nplez1/main upstream/main`
- **old tip** = `git rev-parse origin/nplez1/main` (the released tip; np.8 was built from it)
- **new base** = `git rev-parse upstream/main`

Then size the sync and take a rollback ref:

```bash
git log --oneline <old-base>..upstream/main | wc -l        # upstream commits coming in
git log --oneline <old-base>..origin/nplez1/main | wc -l   # our commits to replay
git branch -f backup/nplez1-main-pre-sync <old-tip>
git config rerere.enabled true && git config merge.conflictStyle zdiff3
```

Optional dry run, which predicts the conflict set without touching the tree:

```bash
git merge-tree --write-tree --name-only origin/nplez1/main upstream/main | head -40
```

**Check the release side too**, because a sync is usually followed by a release: `gh secret list
--repo nplez1/orca` (five signing secrets ⇒ the workflow takes the signed path) and `gh release list
--repo nplez1/orca --limit 5` for the last published version.

If the fork's own `main` is stale (it is the base for PR branches, and `git rebase origin/main` in
LOCAL-PATCHES means *that* branch), it is fast-forwarded to upstream at push time in Step 4, not now.
Nothing on the remote changes until verification passes.

## Step 1 — rebase

```bash
git checkout nplez1/main
git merge --ff-only origin/nplez1/main   # the released tip; fast-forward if the checkout lags
GIT_EDITOR=true git rebase upstream/main
```

Replay order is by commit date, so commits that arrived through a fork merge can land *after* the
commits that refined them. That is expected; see the traps in Step 2.

## Step 2 — resolve conflicts

For every conflicted file, use the three merge stages rather than guessing from the markers:

```bash
f=src/main/ipc/ai-vault-search.ts
for s in 1 2 3; do git show ":$s:$f" > /tmp/$s.ts; done   # 1=old parent 2=ours(new base) 3=theirs(commit)
diff -u /tmp/1.ts /tmp/3.ts   # what THIS commit changes, against its own parent
diff -u /tmp/1.ts /tmp/2.ts   # what upstream+replayed commits already changed
```

The commit's own delta (`1 → 3`) is what has to be re-applied onto the new base (`2`). Stages
survive until you `git add`, so this works at any point in the rebase.

**Classify every conflict, and stop on the substantial ones.**

- **Trivial / mechanical** — resolve and keep going: both sides appended to the same list or import
  block; both added a member to the same union; a rename replay (`codexRoster*` → `agentDescendant*`)
  landing on a file upstream kept editing; an import line in a test.
- **Substantial — stop and report before resolving.** Signals:
  - upstream rewrote the same function or file we did (grok-events.ts: upstream reimplemented our
    `stop_cancelled` fix, 104 → 229 lines);
  - an add/add collision on a file *we* also introduced (ai-vault-search-all-hosts.ts: base 0 lines,
    upstream 318, ours 193 — two independent multi-host engines);
  - the other side is not upstream at all but our own older variant, because the rebase linearised a
    hand-resolved fork merge (see below);
  - the fix upstream landed is a superset of ours ⇒ **drop our commit** rather than keeping a
    duplicate: `git rebase --skip`, and say so in the sync log.

When a conflict means upstream has built the same thing, ask the fork's owner which way to converge
before resolving. Convergence decisions so far are recorded in LOCAL-PATCHES.md § Sync log.

### Traps, all of them hit for real

1. **`git rebase` drops merge commits, and a hand-resolved merge's content exists only in the merge
   commit.** `b1daf0ca58` had resolved six things by hand (the grok/copilot union in
   listener-state.ts, `workingMode: 'monitoring'`, the pi `pi.events` binding, the legacy-adapter
   test helpers, duplicated `StopCancelled` entries). A linear rebase replays only the parents, so
   all of it vanished, and later commits then *looked* like they were removing features. Step 3's
   pre-sync-tip diff is what catches this; resolve any file it flags by taking the old tip's
   content. Only one merge existed in the sync range, which is why this is tractable — if the fork
   starts merging more often, consider `--rebase-merges` or keep the line linear.
2. **A skipped commit may carry more than the one thing upstream superseded.** We skipped
   `ae84a327e7` because upstream had implemented its grok half; it also carried the child-waiting
   fact, the pane-visible assertions and the `StopCancelled` de-duplication. Restore what upstream
   does *not* supersede before continuing.
3. **Renames replay onto files upstream is still editing.** `codex-subagent-roster` →
   `agent-descendant-roster`: apply the rename mapping to upstream's version, longest identifiers
   first (`getOrCreateCodexSubagentRoster` before `CodexSubagentRoster`).
4. **Derived files are regenerated, not merged.** For
   `src/renderer/src/i18n/en-runtime-required.json` (and any locale conflict): union the source
   catalog by hand, then `pnpm run sync:localization-runtime-catalog`. Never hand-merge the derived
   file.
5. **A clean merge is not a correct merge.** Three of this sync's real breaks never conflicted:
   the writer's `storeContent` early return calling `discard()` (a metadata-only index then wrote no
   session row), upstream's per-host `enabled` toggle writing a settings field the fork had renamed
   to `contentEnabled` (a no-op toggle), and two settings surfaces now controlling one consent.
   Step 3's typecheck and tests are what find these.
6. **The commit-msg hook refuses `local(` commits anywhere but `nplez1/main`.** Rebase on the branch
   itself; do not bypass the hook.
7. **Reword a commit whose body no longer describes its content** (ours described the engine we
   dropped). Fold the doc fix in with `git rebase -i <sha>^`, mark it `edit`, amend, continue.

## Step 3 — verify, in this order

```bash
# 1. Nothing of ours was silently lost. Any MODIFIED file upstream never touched is a red flag.
git diff --name-only 291b4ddd6f upstream/main | sort > /tmp/upstream-changed.txt   # <old base>
git diff --diff-filter=M --name-only backup/nplez1-main-pre-sync HEAD | sort > /tmp/modified.txt
comm -23 /tmp/modified.txt /tmp/upstream-changed.txt        # expect empty

# 2. The local() patch series and the dropped commit, patch by patch.
git range-diff --no-patch <old-base>..backup/nplez1-main-pre-sync upstream/main..HEAD

# 3. The gates.
pnpm tc
node -e "require('./config/electron-builder.config.cjs')"   # the fork's builder patch still loads
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
pnpm test <every test file in a touched area>

# 4. Derived catalogs.
pnpm run sync:localization-runtime-catalog
pnpm run verify:localization-runtime-catalog && pnpm run verify:localization-extraction

# 5. The changed-code gate on everything that moved.
pnpm run check:code-quality:changed
```

`pnpm tc` is the strongest single signal: it found both semantic breaks of this sync that no conflict
marker showed.

Then get a second look from a different model before pushing — the Kimi K3 pass in the session that
did this one caught the convergence cost. Ask it to review the conflict resolutions that changed
*behaviour*, not the mechanical renames.

## Step 4 — push

```bash
git push origin upstream/main:main          # fast-forward the stale base PR branches are cut from
git push --force-with-lease origin nplez1/main
```

Force-push rewrites the fork's line; `backup/nplez1-main-pre-sync` and the release tags keep the old
commits reachable, so nothing is lost. Delete the backup ref only once a release has shipped from the
new line.

## Step 5 — record it

- **LOCAL-PATCHES.md § Sync log** — base SHA, upstream commits, which patches needed resolution, what
  was dropped, what diverged deliberately.
- **BRANCHES.md** — the "Last updated" line and the base-drift section: which PR branches now sit on
  the old base (they are rebased parent-first only when someone is about to open them).
- Anything the sync left open, as a named follow-up rather than a TODO in a file.

## Step 6 — release

`gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main`, then follow
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md). The version stamps itself as
`<package.json version>-np.<run number>`, so no number is chosen by hand.
