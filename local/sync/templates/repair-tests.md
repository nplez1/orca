<!--
Test-failure repair, from the unit gate (local/gate-unit.mjs), a single failing file, or an
early-Linux-lane red (UPSTREAM-SYNC-RUNBOOK.md Step 3.5). Group failing files by area, at most ~20
per fixer, and never give two fixers the same file.

  {{WORKTREE}}       the checkout
  {{FILES}}          the failing test files, one per line, in a fenced block
  {{FAILURES}}       the failure excerpt per file (assertion and first stack frame), or "run each file"
  {{ORIGIN}}         where the reds came from: "the Mac unit gate", or "the Linux lane, run <id>" — for
                     a Linux-only red, also give the artifact path from `gh run download <id>`
  {{KNOWN_SHAPES}}   causes already diagnosed for some of these files, one bullet each; "none" if none
  {{SETTLED}}        decisions settled in this sync a fixer could undo, one bullet each
  {{OUT_OF_SCOPE}}   trees another fixer owns right now (e.g. src/renderer/**)
-->

You are fixing test failures left by a large upstream sync, in the worktree `{{WORKTREE}}`. The tree
typechecks; these are behavioural or assertion failures the merge introduced. They came from
{{ORIGIN}}.

YOUR FILES:

{{FILES}}

What they report:

{{FAILURES}}

Run each one on its own: `pnpm test <one file>` (a single test file does not queue and takes seconds).
Read the failure, find the cause in the source it exercises, and fix the **source** where the merge broke
behaviour. Change a test only when it asserts something upstream deliberately changed, and say so.

A red that reproduces only on Linux is not fixed by guessing: if the cause is the Linux runner and not
the code, say so with the evidence, and propose the entry for `local/nightly-linux-known-red.json` (its
`note` field says what an entry must carry) instead of changing the test.

Causes already diagnosed:

{{KNOWN_SHAPES}}

Settled decisions — do not undo them:

{{SETTLED}}

Do not run the full suite, a directory, or `pnpm tc`; do not silence a failure with `any`,
`@ts-expect-error`, `it.skip` or `test.skip`; do not delete a test that still guards real behaviour; do
not touch `package.json`, lockfiles, `local/` (except a proposed known-red entry, reported rather than
written), or {{OUT_OF_SCOPE}}. Do not commit.

Report in under 30 lines: per file the cause and the fix, plus anything you could not fix and why. Leave
every file you own passing.
