<!--
Typecheck repair after a merge. One subagent per TypeScript project, never two on one project
(release-brief.md, "Orchestration" rule 5). Run the project's typecheck once yourself first and save
its output, so the fixer starts from the list instead of a cold run.

  {{WORKTREE}}     the checkout
  {{PROJECT}}      node | web | cli  (the command is `pnpm tc:{{PROJECT}}`)
  {{ERRORS_FILE}}  the saved output, e.g. .git/orca-sync/tc-{{PROJECT}}.txt, and its error count
  {{OLD_BASE}}     the merge base; {{PRE_SYNC_TIP}} the merge's first parent (the fork before the sync)
  {{SETTLED}}      decisions settled in this sync a fixer could undo (moved modules, deleted features,
                   renamed settings fields), one bullet each
-->

You are fixing the residual typecheck errors a large upstream-sync merge left in the
`{{PROJECT}}` TypeScript project, in the worktree `{{WORKTREE}}`. No conflicts remain; this is
mechanical repair, not analysis.

Start from the saved error list, `{{WORKTREE}}/{{ERRORS_FILE}}` (`<file>(line,col): error TSxxxx: …`).
You are the only agent on this project. Re-run `pnpm tc:{{PROJECT}}` (several minutes; give it an
explicit timeout) only after fixing a whole batch of errors, not after each one.

Typical shapes and their fixes:

- a module that moved: find it with `fd -t f '<basename>.ts' src` and fix the specifier;
- a renamed export: `git grep -n 'export .*<name>' MERGE_HEAD -- src | head` (or `upstream/main`) shows
  upstream's name;
- a helper a resolution dropped: recover it from `git show {{PRE_SYNC_TIP}}:<path>` (the fork before the
  sync) or `git show {{OLD_BASE}}:<path>`;
- an unused import or parameter a resolution left: delete it;
- a duplicate declaration: merge both sides' behaviour into one;
- `Promise<x>` used as `x`: add the `await` upstream's now-async function needs.

Settled decisions — do not undo them:

{{SETTLED}}

Never "fix" an error with `any`, `@ts-expect-error`, a cast or a widened type. Do not delete a test
unless the module it tests is gone. Do not run vitest or lint, do not commit, and do not touch
`package.json`, lockfiles or `local/`.

Report in under 25 lines: files changed, anything you could not fix and why, and the final
`pnpm tc:{{PROJECT}}` status line.
