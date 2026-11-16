<!--
Release brief: the canonical way to start a sync + release. Paste it as the first message to the
release agent (Pi or Claude Code), after filling the placeholders and checking nothing still reads `{{`.

  {{WORKTREE}}   the checkout the release runs in, normally /Volumes/Storage/Code/orca/main
  {{NOTES}}      anything specific to this release (a known blocker, a skipped leg), or "none"

It names runbook steps instead of copying their commands, so it cannot go stale: when a runbook
changes, this brief follows it. Extracted from the 2026-11-15 release session; the orchestration
rules at the end are that run's measured lessons.
-->

You are the release engineer for Orca NP, working directly in the main checkout at `{{WORKTREE}}` on
branch `main`. Do not create a workspace or a feature branch. Ship the next Orca NP release end to end:
sync upstream first, then run the release runbook including its review gate, and publish the release.

This is a long, high-stakes task. Continue until the release is published (or you are truly blocked),
not until you have a status report. Do not skip, waive or fake a gate.

Notes for this release: {{NOTES}}

## 1. Pre-flight

- Read `UPSTREAM-SYNC-RUNBOOK.md`, `RELEASE-RUNBOOK.md`, `BRANCHES.md`, `LOCAL-PATCHES.md`,
  `local/sync/convergence-ledger.md` and `local/sync/README.md` before touching anything. Follow the
  runbooks exactly; where this brief and a runbook disagree, the runbook wins.
- `git status` must be clean; fast-forward `main` to `origin/main`; fetch `origin` and `upstream`.
- Record the upstream base you actually merge (`git rev-parse upstream/main`) and how far ahead it is.

## 2. Upstream sync — `UPSTREAM-SYNC-RUNBOOK.md`

- Follow Steps 0 and 1.
- Follow Step 2. Settle what the ledger and the manifest already answer, and what
  `conflicts.mjs --propose` / `--apply-proven` can prove, yourself. Fan the rest out to resolver
  subagents using `local/sync/templates/conflict-protocol.md` (written once to
  `.git/orca-sync/PROTOCOL.md`) and one `local/sync/templates/resolve-batch.md` prompt per batch. Stop
  and report only for a substantial convergence question the ledger does not answer; otherwise decide,
  record the decision in the ledger, and continue.
- Follow Step 3. Repair what it finds with the repair templates (`local/sync/templates/repair-*.md`).
- Follow Step 3.5 (the early Linux lane) as soon as post-sync and `pnpm tc` pass, and triage its reds
  while the local gates run.
- Follow Steps 4 and 5.

## 3. Release — `RELEASE-RUNBOOK.md`

- Follow Step 0.5, then Step 1.5. Repair gate reds with `repair-tests.md` / `repair-lint.md`.
- Follow Step 1.6, the review gate, exactly as written there. Fix its findings with
  `repair-review-findings.md`. Do not use `--waive-review`.
- Re-run the early Linux lane on the final revision (UPSTREAM-SYNC-RUNBOOK.md Step 3.5), then follow
  Step 2 to dispatch. Never `gh workflow run fork-release.yml` directly.
- Watch the run once (`gh run watch <id> --compact --exit-status`), read the draft release body as the
  runbook's "Release notes" section says, and publish only when it is right.
- Verify the published release: its tag, that it is marked Latest, and that its asset list matches the
  previous release's (`gh release view <previous tag> --repo nplez1/orca --json assets`) leg for leg,
  update manifests included.

## Rules

- Do not hand-build release artifacts. Do not bypass the commit-msg hook or any gate.
- Update the main workspace comment at meaningful checkpoints:
  `orca-np worktree set --worktree path:{{WORKTREE}} --comment "<checkpoint>" --workspace-status in-progress`.
- If truly blocked, post one clear blocker naming the exact gate or command, the error, and what is
  needed. Otherwise keep going.

## Orchestration — how to run the subagents

These come from the 2026-11-15 run, where they cost hours. They apply in Pi and in Claude Code.

1. **Batches of at most 20 paths.** Split the conflict set by path area first, then by count. That run
   cut 694 conflicts into six area batches of 17–76; the 51-file `src/main/{runtime,ipc,…}` batch staged
   nothing in 26 minutes and held the whole sync, while the two re-splits of it (22 and 19 files)
   finished in 8–10 minutes each. Twenty keeps a batch near ten minutes and bounds what one stalled
   resolver can hold. Up to eight resolvers at once has worked; start the next batch as one finishes.
2. **File by file.** A resolver resolves one file, checks it for markers and `git add`s it before
   opening the next. The stalled resolver spent its time composing one whole-batch tool call that hit
   the output-token limit, with nothing staged. `git ls-files -u` against the batch's list is then a
   true progress count.
3. **Resolvers never run repo-wide commands**: no `pnpm tc`, `pnpm test`, `pnpm lint`, `pnpm install`,
   vitest, `git log` over full history, or any command that rewrites many paths. You run the gates,
   once, centrally.
4. **Wait on the harness, not on `sleep`.** Block on the subagent's completion notification or the
   harness's result tool (Pi: `get_subagent_result`; Claude Code: the background-agent completion
   notification). That run spent 162 minutes in 23 `sleep 120`–`sleep 720` polls that learned nothing a
   notification would not have told it. Between your own work items a one-shot `git ls-files -u` count
   is fine; a loop is not.
5. **One runner per heavy gate.** While a subagent is fixing a gate, do not run that gate yourself, and
   never give two concurrent subagents the same heavy command: split typecheck repair by project
   (`tc:node`, `tc:web`, `tc:cli`), never two agents on one project. Run the gate once when every fixer
   has reported, save its output under `.git/orca-sync/`, and hand each fixer its own excerpt.
6. **Bound every heavy command with an explicit timeout** in the harness's unit: Pi's bash takes
   seconds (`600`), Claude Code's takes milliseconds (`600000`).

## Final report

Upstream base SHA, merge commit, sync result, review verdict (the manifest path), release tag, run ID,
asset count against the previous release, release URL, the Linux-lane run IDs, and anything left open.
