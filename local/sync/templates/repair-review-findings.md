<!--
Fixing the findings of the release review. The review itself is RELEASE-RUNBOOK.md Step 1.6 — follow
that step to run it and to record its manifest; this template only hands its findings to a fixer. Group
findings by area so no two fixers share a file.

  {{WORKTREE}}       the checkout
  {{REVISION}}       the reviewed revision
  {{PRE_SYNC_TIP}}   the merge's first parent (the fork before the sync), for recovering fork code
  {{FINDINGS}}       numbered: severity, file, the defect, and the fix the reviewer verified — verbatim
                     where possible
  {{GATE}}           the checks that prove these fixes: the project typecheck (`pnpm tc:node` or
                     `pnpm tc:web`) and the single test files that cover the touched code
-->

The release review of `{{REVISION}}` (RELEASE-RUNBOOK.md Step 1.6) found defects in the merge
resolution. Fix these, in the worktree `{{WORKTREE}}`. Each item states the defect and the fix the
reviewer verified; keep each fix minimal and touch nothing else.

{{FINDINGS}}

How to recover what a resolution dropped: `git show {{PRE_SYNC_TIP}}:<path>` is the fork before the
sync, and `git show upstream/main:<path>` is upstream's file. When a finding says both sides' behaviour
must survive, start from upstream's file and re-apply the fork's delta.

A finding that a fork-owned test was lost is fixed by restoring the fork's own cases next to the module's
current home — not upstream's retired suite — and each restored case must fail if the behaviour it guards
is reverted.

Gate: {{GATE}}. Run single test files only (`pnpm test <one file>`; a directory queues). Do not use
`skip`, `any` or `@ts-expect-error`, do not commit, and do not touch `package.json`, lockfiles or
`local/`.

Report in under 15 lines: what you changed per finding and the verification you actually ran. The
re-check of these fixes is the delta round Step 1.6 describes; do not run a review yourself.
