<!--
One resolver subagent per batch. A batch is at most 20 paths from one area (release-brief.md,
"Orchestration" rule 1); write its list to `.git/orca-sync/batch-{{BATCH_ID}}.txt`, one path per line.

  {{WORKTREE}}        the checkout the merge is in
  {{BATCH_ID}}        a short unique id, e.g. c2
  {{FILE_COUNT}}      the number of paths in the list (<= 20)
  {{AREA}}            the area, e.g. "src/main/{ipc,window,persistence}"
  {{OTHER_BATCHES}}   the areas other resolvers are working right now
  {{LEDGER_NOTES}}    the ledger decisions that cover this area, one bullet each, quoted or summarised
                      from local/sync/convergence-ledger.md with the section name; "none" if none
  {{SETTLED}}         decisions settled earlier in this sync that a resolver here could undo (moved
                      modules, deleted features, renamed exports); "none" if none
-->

You are resolving ONE batch of file conflicts from an in-progress `git merge` (upstream stablyai/orca
into the Orca NP fork's release line) in the worktree `{{WORKTREE}}`.

FIRST read `{{WORKTREE}}/.git/orca-sync/PROTOCOL.md`. It is binding: the index-stage convention (in this
merge `:2:` = ours = the fork, `:3:` = theirs = upstream, `:1:` = the merge base), the rules and the
report format.

YOUR FILES: exactly the {{FILE_COUNT}} paths in `{{WORKTREE}}/.git/orca-sync/batch-{{BATCH_ID}}.txt`
({{AREA}}). Do not modify any other file — other resolvers are working {{OTHER_BATCHES}} in this
worktree at the same time.

How to work, one file at a time:

1. `git show :2:<path>` and `git show :3:<path>` — the two sides as they really are.
2. `git diff <merge base> HEAD -- <path>` — the fork's delta, the intent you must preserve;
   `git diff <merge base> MERGE_HEAD -- <path>` — upstream's.
3. `rg -n '<feature or path>' local/sync/convergence-ledger.md` for a decision covering the file; a
   ledger entry is binding.
4. Write the resolution, confirm `rg -c '^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)' <path>` finds
   nothing, `git add <path>`, and only then open the next file.

Decisions from the ledger that cover this area (binding):

{{LEDGER_NOTES}}

Decisions settled earlier in this sync (do not undo):

{{SETTLED}}

Never run `pnpm`, vitest, a full-history `git log`, or anything that rewrites many files. Report as
PROTOCOL.md says, in under 40 lines: one line per file, then up to five `NEEDS-DECISION` lines, then
anything left unresolved.
