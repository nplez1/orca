<!--
Lint-step repair, from `local/gate-lint.mjs` or the changed-lines gate. Each fixer owns a disjoint set
of steps and the files those steps own; nobody runs `local/gate-lint.mjs` while fixers are working.

  {{WORKTREE}}       the checkout
  {{STEPS}}          the failing step names, one per line, in a fenced block (each runs as
                     `pnpm run <name>`; name the exact command for a step that is not a package script)
  {{STEP_NOTES}}     per-step guidance already known (what the step compares, its regenerate or
                     `--prune` command), one bullet each; "none" if none
  {{OTHER_FIXERS}}   the steps and paths other fixers own right now
-->

You are fixing failing lint steps after a large upstream sync, in the worktree `{{WORKTREE}}`. The tree
typechecks and its tests pass; what remains is the lint gate, which runs each step on its own.

YOUR STEPS — run each with its own command and fix it at the source:

{{STEPS}}

Other fixers own {{OTHER_FIXERS}}. Do not run `local/gate-lint.mjs` (it would run their steps against
their half-finished work), and do not touch the files their steps own.

Known guidance per step:

{{STEP_NOTES}}

Expect a merge's usual shapes: stale import specifiers, a scan that reads a file by a path that moved, a
baseline keyed on paths that no longer exist, a generated catalog that needs regenerating rather than
hand-merging, and counts that moved in both directions.

The ratchet policy (`LOCAL-PATCHES.md` § `local(lint)`):

- a count that **shrank** is re-recorded with the ratchet's own `--prune`, never `--init`;
- a count that **grew** is a finding: find what the merge added and fix it. Where the file is
  upstream-owned and the fork's own delta is what grew it, the documented exception is one disable with
  a `-- Why:` naming the delta plus one baseline row — check first that the growth is not a merge
  artefact to revert;
- `node local/check-upstream-file-comments.mjs` takes `--prune` when its total shrank and
  `--init --accept "<what the sync added and why>"` when it grew;
- a `local/lint-known-red.json` row the report calls stale is pruned.

Never silence a step with a new disable, `@ts-expect-error`, `any`, `wholeStep` or a raised cap, and do
not touch `package.json` or lockfiles. Do not commit.

Gate: every step in your list exits 0. Report in under 25 lines: per step, the cause and the fix or what
you re-recorded.
