<!--
Conflict-resolution protocol for resolver subagents. Write it once per sync, filled, to
`.git/orca-sync/PROTOCOL.md`; every resolve-batch.md prompt points at that copy.

  {{WORKTREE}}      the checkout the merge is in
  {{OLD_BASE}}      the merge base, `git merge-base HEAD MERGE_HEAD` (recorded by pre-sync.mjs)
  {{UPSTREAM_SHA}}  the upstream tip being merged (MERGE_HEAD)
  {{RENAME_COUNT}}  how many paths upstream moved, from `.git/orca-sync/renames.txt`

`.git/orca-sync/renames.txt` (`old -> new`, one per line) is written before fan-out, e.g. from the
`R` lines of `git status --porcelain -M`.
-->

# Conflict-resolution protocol — upstream sync (merge in progress)

Worktree: `{{WORKTREE}}`, branch `main`. A **merge** of upstream into the release line is in progress;
`git ls-files -u` lists the unmerged paths.

- merge base (old base): `{{OLD_BASE}}` — `git diff {{OLD_BASE}} HEAD -- <path>` is the fork's own delta.
- upstream tip: `{{UPSTREAM_SHA}}` — `git diff {{OLD_BASE}} {{UPSTREAM_SHA}} -- <path>` is upstream's.
- In a **merge** the index stages are `:1:` base, `:2:` ours (the fork), `:3:` theirs (upstream).
  `--ours`/`--theirs` are inverted against a rebase, so never use the flags; read the stages:
  `d=$(mktemp -d); for s in 1 2 3; do git show ":$s:<path>" > "$d/$s"; done`

## Rules

1. **Only touch the files in your assignment.** Other resolvers are working other batches in this
   worktree at the same time. Never run a command that rewrites many files (`git checkout --ours .`,
   `git restore .`, `git stash`, `git reset`).
2. **One file at a time.** Resolve it, confirm it has no markers, `git add` that one file, then open the
   next. Never write a script or a single tool call that resolves the whole batch.
3. Resolve from the **index stages**, never from the markers. Markers are merged text; the stages are
   the two real sides.
4. **Upstream's shape wins; the fork's intent is re-applied on top.** Start from stage 3 and re-apply the
   fork's delta, adapted to upstream's structure. Never copy the pre-sync fork file over upstream's
   rewrite (the ledger's "re-home, do not revert"). Keep a whole fork file only when it is genuinely
   fork-only behaviour upstream does not have.
5. **Unions**: both sides added to the same list, import block, union type or map → keep both and drop
   duplicates (a member both sides already had appears once). Check commas and trailing members.
6. **Renames**: upstream moved {{RENAME_COUNT}} paths. `.git/orca-sync/renames.txt` maps `old -> new`;
   use it to re-point imports, and prefer the new path.
7. **Identity (fork invariant)**: this fork ships as **Orca NP** — `~/.orca-np` (not `~/.orca`), bundle
   `com.nplez1.orca`, packaged userData `appData/orca-np`, CLI `orca-np`/`orca-np-dev`, NSIS ProgIDs
   `OrcaNP.*`, daemon root `%LOCALAPPDATA%\orca-np`, release feed `nplez1/orca`. Never let a resolution
   regress one of those to upstream's value. The `orca://` scheme and the plain `orca` relay shim are
   deliberate exceptions.
8. **Derived files are regenerated, not merged.** Union the _source_; never hand-merge a generated
   artifact (`src/renderer/src/i18n/en-runtime-required.json` is regenerated centrally). Locale catalogs
   union keys.
9. **Never run repo-wide commands.** No `pnpm tc`, `pnpm test`, `pnpm lint`, `pnpm install`, vitest,
   full-history `git log`, or repo-wide search-and-replace. Read single files and single diffs; the
   release engineer runs the gates centrally.
10. **Do not change** `package.json`, lockfiles, `.github/workflows/fork-*` or anything under `local/`.
    Do not commit and do not `git merge --continue`.
11. Leave **no conflict markers** in a file you report done: `<<<<<<<`, `|||||||`, `=======`,
    `>>>>>>>`.
12. **Ambiguous file?** Take upstream's shape plus the fork's delta, note it in your report, and move on
    — do not stall the batch on it.

## Report

Before reporting, confirm none of your paths is still unmerged (`git ls-files -u | grep -F -f <list>`).
Then, for every file in your assignment, one line:

```
<path> — <what won and why, in <= 12 words>
```

Then a `NEEDS-DECISION:` list for anything genuinely substantial (upstream built the same feature
differently, an add/add of two real implementations, a resolution that changes behaviour), each with
the question and your recommendation. Name any file you left unresolved, and why.
