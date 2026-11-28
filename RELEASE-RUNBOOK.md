# Release runbook

How to go from "certificate approved" to "four machines running my fork on my own update channel".
Everything here is fork-only; none of it touches upstream.

Companions: [BRANCHES.md](./BRANCHES.md) for branch state, [LOCAL-PATCHES.md](./LOCAL-PATCHES.md)
for the fork-only patches the builds depend on, and
[UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md) for the sync that usually precedes a
release. Bring upstream in first — a release built from a stale base cannot see the fixes upstream
has since landed. An agent running the sync and the release end to end starts from
[local/sync/templates/release-brief.md](./local/sync/templates/release-brief.md), which walks both
runbooks step by step.

## What is already done

- Update feed re-pointed to `nplez1/orca` (six references) — the reason a build of this fork updates
  from this fork instead of being offered an official release.
- `publisherName` dropped, so unsigned Windows installers update themselves.
- `.github/workflows/fork-release.yml` registered and active.
- Actions enabled on the fork; `main` is the default branch, which is what makes a
  `workflow_dispatch` workflow runnable at all. That is repository state, not tree state — a merge can
  flip it back, so re-check it after every merge (Step 0.5).
- Pushing works over `ssh://git@ssh.github.com:443/...` (port 22 is blocked on this network).

## Step 0 — validate the pipeline unsigned first (already done; skip unless the workflow changes)

**Why:** if you set the certificate first and the run fails, you cannot tell a pipeline bug from a
signing bug. Run it once with no secrets — nothing gets deployed, and a green run proves the build,
the publish, and the `latest-mac.yml` / `latest.yml` manifests.

This step is **complete** — the pipeline ran unsigned on 2026-09-16 and has published every release
from np.6 to np.11 since, so the only reason to repeat it is a change to `fork-release.yml` itself.

**It is no longer the way to validate a workflow change.** `MAC_CERTS` is set, so a dispatch signs and
notarizes; an unsigned run would mean deleting the secret. And an unsigned run was never
"nothing deployed": it ended in `--draft=false`, so it published a real release that every install
updates to. Validate with `keep_draft` instead — the whole run, signed, with every check in `publish`,
stopping one command short of the undraft:

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref main -f keep_draft=true
gh run watch --repo nplez1/orca
gh release view v<version> --repo nplez1/orca --json isDraft,assets --jq '.isDraft, .assets[].name'
gh release delete v<version> --repo nplez1/orca --yes   # a draft has no tag to clean up
```

It still consumes a run number and must pass the same gates and version guard, so it is a real
dispatch in every respect but the last step. What it proves for the parallel legs (2026-11-16): one
release carries the tag, every leg appended to the draft `release-draft` created, and all three
manifests are on it. The `local/dispatch-release.mjs` gate does not pass `keep_draft`; a validation
run publishes nothing, so dispatching it directly is not a bypass.

A published release should appear with `latest-mac.yml`, the `.zip`, the `.dmg`, `latest.yml`,
`orca-windows-setup.exe`, `latest-linux.yml`, the `.AppImage`, the `.deb` and the `.rpm`, and a body that opens with a generated change summary (see
[Release notes](#release-notes--read-the-draft-before-it-goes-live) below). Keep that release; it is
also your rollback artifact.

## Step 0.5 — after every upstream merge, re-check Actions enablement

**Why:** upstream's Actions fleet is disabled at the repository, not in the tree (the `local(ci)`
entry in [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) records it), so nothing in a merge diff shows that
state. A sync that adds a workflow brings it in **enabled**, and a workflow file upstream edits comes
back enabled even though this fork had turned it off. An enabled workflow with a `pull_request`,
`push`, or `schedule` trigger then spends minutes on every PR — `dependency-security.yml` came back
this way on 2026-10-23 and was firing on any PR that touched a lockfile.

Only `fork-release.yml` and `fork-upstream-tags.yml` must be active; the seven other entries the
script knows (`zcode-account-contract`, the two benchmarks, `ci-cache-warmup-platform-jobs`,
`qualified-orcad-template`, `layout-owner-e2e`, `dev-channel-win-publish`) are
`workflow_dispatch`/`workflow_call`-only and inert.

```bash
node local/check-actions-enablement.mjs          # report; exit 1 on drift
node local/check-actions-enablement.mjs --fix    # disable everything outside the fork's live list
```

Run it after any sync that touches `.github/workflows/**`, and once more **before** triggering a
release — a workflow that came back enabled during the sync will otherwise start its own run on the
release push.

## Step 1 — the five secrets

Set these on `nplez1/orca` → Settings → Secrets and variables → Actions. Never in the repo.

| Secret                        | What it is                                                           |
| ----------------------------- | -------------------------------------------------------------------- |
| `MAC_CERTS`                   | base64 of the exported `.p12` — `base64 -i cert.p12 \| pbcopy`       |
| `MAC_CERTS_PASSWORD`          | the password you set when exporting the `.p12`                       |
| `APPLE_ID`                    | the Apple Account email you enrolled with                            |
| `APPLE_APP_SPECIFIC_PASSWORD` | from account.apple.com → Sign-In & Security → App-specific passwords |
| `APPLE_TEAM_ID`               | Membership details in the developer portal                           |

The certificate must be **Developer ID Application**, created from a CSR generated in Keychain
Access and exported **with its private key**. `config/scripts/verify-macos-release-env.mjs` fails the
run if any of the five is missing, before the build starts.

## Step 1.5 — the unit gate, on the revision being released

This is where the full unit suite runs. It is deliberately **not** a PR gate any more, except for a diff
carrying a global input (`~/Code/orca/AGENTS.md` § Verification tiers, the cross-worktree file; this
repo's `AGENTS.md` has no such section): requiring it per branch is what had agents
running it five times a session.

```bash
orca-queue node local/gate-unit.mjs   # full suite + known-red verdict, cached per revision
pnpm tc                               # must be clean; nothing to allowlist here
orca-queue node local/gate-lint.mjs
```

- `gate-unit` must report **PASS**. A failure listed in `local/unit-known-red.json` does not fail it;
  anything outside that list does, and so does a non-zero exit the run cannot account for.
- The verdict is cached per (revision, allowlist, gate inputs) under `.git/orca-gate/`, so re-running
  on an unchanged revision returns the same answer immediately. Do not re-run to chase green.
- Paste its summary line into the release notes. That line is the claim this step makes checkable.

Check the nightly before cutting, not after (`--branch main`: a candidate dispatch is a run of the same
workflow, and would otherwise be what `-L1` shows):

```bash
gh run list --workflow fork-main-tests.yml --branch main -L1 --repo nplez1/orca
```

A red there is a failure the Mac's allowlist cannot see, because the Linux runner has its own red set.
Triage it first. If that nightly is green on the exact commit being released, record it in the release
notes — it covers the Linux runtime better than the local gate does, though the local gate is still
the only one that exercises the darwin-bound classes, so substituting it is a judgement call and not
something to do silently.

**Precondition: the early Linux lane is green on the revision being released**
(UPSTREAM-SYNC-RUNBOOK.md Step 3.5, `node local/sync/linux-lane.mjs`) — the same suite this dispatch
runs, on the same runner, without a dispatch loop per red. Only a later commit that touches nothing but
`local/sync/release-review/*.json` keeps an earlier green; a markdown change does not, because some
suites read the repository's `*.md`.

Since 2026-10-29 the dispatch carries the same coverage itself: `fork-release.yml` runs the unit suite
on the dispatched commit (`unit-plan` → `unit-tests`, the same reusable workflow, shard plan and fork
shard verdict as the nightly), `typecheck` runs `pnpm tc` on it, `lint` runs
`node local/gate-lint.mjs` against the tree's own `local/lint-known-red.json`, and every artifact leg
waits for all three. So a dispatch can no longer publish with no test evidence, and there is no flag to
skip it. If one of them is red there, the fix is the one above — fix it, or classify it in
`local/nightly-linux-known-red.json` (suite) or `local/lint-known-red.json` (lint) with evidence — not
a retry.

For `typecheck` and `lint` the release lane is a backstop, not a wider net: it runs the same TypeScript
projects, the same lint steps and the same allowlist (`local/lint-known-red.json`) on `ubuntu-latest`, so
a green there restates a green here rather than adding coverage. What it adds (#298) is that a dispatch
cannot outrun those verdicts. Nothing checks `Fork base gates` was green for the commit being published
— `local/dispatch-release.mjs` reads the review, the tree, the ref and the Actions fleet — so before this
change the compiler's verdict at publish time was whatever the dispatcher happened to have run by hand.
A typecheck red has no allowlist: the fix is a clean `pnpm tc`, the same as this step's.

### The order that keeps the review valid

Every gate repair moves HEAD and a review covers a revision, so the gates go **before** the review,
never after it:

1. Finish every code edit and every review fix.
2. `orca-queue node local/gate-lint.mjs`.
3. `orca-queue node local/gate-unit.mjs`, `pnpm tc`, and the early Linux lane on that same HEAD.
4. The review, then its delta round on the fix commit.
5. From here to the dispatch, only review-neutral commits: `*.md` and `local/sync/release-review/**`.

On the 2026-11-24 release lint failed 5 of 11 runs, and each repair moved HEAD _after_ the review was
written, so every one of them voided it and opened another delta round. `--prepare` now refuses outright
until the lint and unit gates pass on HEAD — the same rule enforced rather than described.

Packaging is the one gate with no local form today, and that is what the same release paid for: all three
package jobs failed on a bare `socket.io-client` import, discovered only when the release itself was
dispatched. Before step 4, produce one artifact and point the packaging guard at it:

```bash
pnpm build:unpack                             # one platform, --dir: minutes, not a release
node local/verify-packaged-bundle.mjs         # exit 2 means nothing was checked, never a pass
```

## Step 1.6 — the review gate, before the dispatch

**Why this is a step and not a note.** On 2026-11-10 this release shipped after a review that had spawned six
slices and received findings from three. The reviewer returned "done", the summary said "three slices
completed", and nothing anywhere could tell a half-read resolution from a fully read one — so the dispatch
took a third of its review. Two of the six defects that review did find were invisible to `pnpm tc` (one sat
in a `@ts-nocheck` file), which is exactly the class a review exists for and a green suite cannot see.

`local/open-pr.mjs` already refuses a PR body without a review claim. The release had no equivalent, and
`gh workflow run` accepts any state of the tree — so the gate is now mechanical, and **`gh workflow run
fork-release.yml` is no longer the way to release.**

```bash
node local/release-review-gate.mjs      # REFUSE until every slice of the review has a verdict
```

Completeness is a manifest, not a claim: `local/sync/release-review/<revision>.json`, committed, listing
every slice with its verdict and its unresolved count. A slice that was dispatched and never answered is
recorded `"no-report"` and **fails** — silence is the failure this gate was built for, so it may not be
represented by an absent field. A waiver clears silent slices and never the reviewer, because the reviewer
is a fact about which review happened.

### Running the review — `local/release-review-packets.mjs`

The review is four commands, not an improvised script. On 2026-11-15 it was improvised: a 10.1 MB remerge
diff cut into six equal line ranges, a hand-written prompt, six `claude -p … &` runs of which four failed
first time because the sandbox refused `/tmp` and `git show --remerge-diff`, two hand-written delta prompts,
and a manifest assembled by hand. 62% of that diff was generated or mechanical content.

The review runs in **two tiers**: a fine sweep that FINDS on the cheap tier, and REVIEWER's adjudication that
JUDGES every finding it raised. Measured on 2026-11-21 against the 2026-11-20 sync: the sweep is 153 slices
of ~24 KB for a few dollars, the adjudication is one packet per 12 findings for ~$2.50, and the pair beats
the 435-slice Opus review that cost $351.65 — nine consolidated Opus slices alone found 3 of the 10 blocking
defects, and the cheap tier at fine granularity found 4 of 4 of the ones they dropped.

```bash
node local/release-review-packets.mjs --prepare              # the reviewer round's packet: diff, filter, slice
node local/release-review-packets.mjs --prepare --sweep      # the fine sweep packet (24 KB a slice)
#   fan the sweep's prompt-<id>.txt out to cheap-tier subagents by path (each Reads its own
#   file; it carries its patch inline, so pasting 153 of them through one context is ~3.7 MB),
#   then record their replies:
node local/release-review-packets.mjs --record-sweep ~/answers.json
node local/release-review-packets.mjs --prepare --adjudicate # REVIEWER judges every sweep finding
node local/release-review-packets.mjs --run --packet "<git dir>/orca-review/sync-<merge>/adjudicate"
# fix the blocking findings, commit, then re-check the fix as a delta round:
node local/release-review-packets.mjs --prepare --delta <R1>..<R2>   # findings default to the open ones
node local/release-review-packets.mjs --run                  # runs only the new delta slice
node local/release-review-packets.mjs --write                # records the manifest for the revision it covers
node local/release-review-gate.mjs                           # still the authority
```

- **`--prepare --sweep`** cuts the same reviewed diff at `--sweep-kb` (default 24) into
  `<sync packet>/sweep/`. The slices are small because that is where the defects are: a 380 KB slice reads
  past a dropped `clearPendingClone` that a 5 KB one catches. Sweep the whole diff, not a subset — a fine
  slice costs $0.012 on the cheap tier.
- **`--record-sweep ~/answers.json`** takes `[{ "id": "A", "answer": "<the reply, verdict block included>" }]`
  and writes one record per slice. The verdict block is re-parsed by the same validator the CLI path uses, so
  a malformed reply is recorded as `no-report` and the gate refuses it by name. An id the packet never
  planned, or a second answer for the same slice, is refused rather than written.
- **`--prepare --adjudicate`** builds one packet per 12 findings: the findings, plus the resolution hunks of
  the files they name. REVIEWER answers, for every finding, real-or-not, at what severity, with the fix —
  and then is asked what the sweep missed in those files. One packet of 10 findings cost $2.50 and dismissed
  one with evidence (it checked the fork tip and found the test had been deleted a sync earlier, so the
  finding was not real).
- **The gate refuses** a release whose sweep has a silent slice, whose sweep finding nobody adjudicated, or
  whose adjudicated BLOCKER/SHOULD-FIX is neither fixed nor dismissed with a reason.

- **A delta that reports nothing above MINOR/NIT closes the loop.** MINOR and NIT are listed in the PR
  body, not fixed and not re-reviewed — on the 2026-11-24 release rounds 5–14 found 0 blockers and 1
  SHOULD-FIX, and the 14-round tail cost ~$60. A fourth delta round needs the user's explicit approval:
  say what is still outstanding and let them decide.

- **`--prepare`** writes `git show --remerge-diff` of HEAD's sync (the newest first-parent merge, or
  `--merge <sha>`) into `<git dir>/orca-review/sync-<merge>/`, never `/tmp`. It leaves out content another gate
  verifies, by the rule list in `local/review-packets/exclusions.mjs`. Each rule names its check: locale
  catalogs → `post-sync:locale-drift` + `verify:localization-catalogs`, ratchet baselines → the ratchet that
  reads that file, generated catalogs → their `verify:*` step, mobile vendor bundles → the postinstall
  generator their header names. A rule whose check is not in `local/gate-lint.mjs` or the post-sync rows
  excludes nothing (`react-compiler-bailout-baseline.txt` stays in, because its ratchet runs only in upstream
  CI). Every excluded file is still listed in each prompt with its status and `+/-` counts, because whether it
  belongs in git at all is still the reviewer's question. The slices are path-prefix runs under a byte
  budget (`--budget-kb`, default 384). A file is split, at hunk boundaries, only when it alone is over the
  budget.
- **`--run`** drives the reviewer `REVIEWER` names (`--model <alias> --effort <thinking>`). It allows only
  Read/Grep/Glob and read-only git (`--permission-mode dontAsk`) and hands the reviewer the packet with
  `--add-dir`. Each slice writes `out-<id>.json`, `err-<id>.log` and `run-<id>.json` next to its prompt.
  A non-zero exit, an `is_error` result, an answer without its closing ` ```orca-review-verdict ` block, or a
  run the CLI refused the packet read on is `no-report`, and so is every slice of a batch that changed the
  working tree. A re-run runs only the slices that have no report. `--max-budget-usd` caps each slice,
  `--slices A,C` narrows the run, and `--concurrency` defaults to 6.
- **`--print` / `--write`** generate the manifest from the outputs: per slice its verdict, counts, cost and
  findings (ids `A-1`, …), with `unresolved` counting the BLOCKER/SHOULD-FIX findings that no later delta
  round has marked resolved. The revision the manifest names is the one the review **covers** — the merge,
  then the end of each delta round — never today's HEAD, because a code commit after the last reviewed range
  was never read by a slice. The gate then accepts only doc and review-record commits on top of it, which is
  its own rule. Both modes exit 1 and say why while the manifest would not clear; `--write` refuses to record
  one, and reports code changed past the covered revision as a missing delta round. A merge that resolved
  nothing writes no slices at all, and the gate refuses an empty slice list — that release needs a waiver
  with its reason, because there is no review to record.

`node local/release-review-gate.mjs --print` still prints the bare manifest shape, for a waiver or a review
run some other way.

#### What the review costs, and the number to watch

`--prepare` ends with an estimate. Read it before `--run`, because the reviewer's cost is **per slice
first, per byte second**: every slice is a fresh `claude -p` session that writes its ~89k-token context at
the cache-write rate, then reads the code around its hunks, and each turn re-reads the whole growing
context. On a 1.5 KB slice the boot dominates ($0.78, 89% cache writes); on a 340 KB slice the reads do
(11.5M cache-read tokens, $4–7.65 a slice). Measured twice: **$0.75 a slice + $14 a MB** — a 1.5 KB slice
cost $0.78, and the same 3.06 MB diff consolidated into nine slices cost $47.90.

The 2026-11-20 review cost 35% of a week's Claude budget for one reason: a packer bug sent the 1 MB
`src/renderer/**` group through the over-budget path, which emitted one slice per file — 428 slices averaging
1.5 KB — and 411 of the 435 slices were under 10 KB. The same diff is 9 slices at the default budget, so
when the estimate looks wrong, suspect the plan, not the reviewer: a median slice under 8 KB now warns and
`--max-estimate-usd <n>` refuses.

**Granularity decides what is FOUND; the model decides how it is JUDGED.** Re-run blind against that merge
on 2026-11-21: the nine consolidated Opus slices ($47.90) found 3 of the 10 blocking findings; the 435
fine-grained slices ($352) found all 10; the cheap tier on nine consolidated slices ($0.40) found 1, and
called a real dropped `clearPendingClone` correct and a real mobile merge regression a NIT. The cheap tier at
_fine_ granularity found 4 of 4 of the ones consolidation dropped, for $0.048 on four slices.

That is why the review is two tiers and not one. A sync this size now costs roughly: **sweep ~$3, round 1
~$48, adjudication ~$2.50 a packet, deltas ~$1.50 each — about $55–60 against $352**, with better recall than
the expensive review, and inside one 5-hour window. Round 1 is kept because it and the sweep find different
things: it reads the whole diff at a scale where only Opus can hold the context, and it raised two
SHOULD-FIX defects the sweep did not (an await gap opened by making `applyHostSettingsReplication` async, and
a deleted spec that took the fork's setup-runner state) while the sweep raised two it did not (a fork-only
runtime name-filter suite and a fork-only updater lifecycle test, both deleted by the resolution). Dropping
either tier leaves a class of defect with no reader.

## Step 2 — publish the first signed release

```bash
node local/dispatch-release.mjs                     # gate, then dispatch
node local/dispatch-release.mjs --dry-run           # inspect the preconditions, dispatch nothing
node local/dispatch-release.mjs -f version_suffix=np.50
node local/dispatch-release.mjs --waive-review "<why>"   # records the reason; never silent
```

It refuses on four preconditions, cheapest first: the review of this exact revision is complete; the tree
is clean; HEAD is `origin/main`; and the Actions fleet is swept. Nothing is dispatched on a refusal.

The version is stamped `<upstream base version>-np.<run number>` by the workflow, and the base is the
newest **upstream release tag** at or before the commit this fork's sync is keyed to
(`.github/scripts/fork-upstream-base-version.mjs`). Not `package.json`: upstream bumps that on its
release line, so `main` can sit months behind its own tags — on 2026-11-28 `package.json` said
`1.4.214` (unchanged since that release, 2026-09-26) while the newest tag was `v1.4.279`, and a build
carrying `1.4.279`'s code stamped `1.4.214` told a reader nothing about what they were running. The
base is therefore what a user compares against upstream, and the nearest tag _after_ the sync base is
deliberately not used: this build does not carry it.

The suffix matters twice: it keeps fork releases strictly newer than each other, and it makes a fork
build identifiable if someone reports a bug — upstream has never shipped that version. The script
warns and falls back to `package.json` when the clone carries no eligible tag, so a missing tag mirror
cannot stall a release.

Two things about it are enforced by the `release-ref` job before any artifact is built
(`.github/scripts/fork-release-version-guard.mjs`):

- **the suffix must match `^np\.[0-9]+$`.** Semver compares a pre-release label alphabetically, so
  `rc.1` on the same base outranks every `np.<n>` of that base — installs move to it and nothing
  published afterwards is ever offered again. `local` sorts below `np`, so a `-local.` build takes the
  release on its own base too.
- **the version must be above the newest published `v*-np.*` tag.** `github.run_number` restarts at 1
  if this workflow file is renamed or re-created, after which every new release sorts below the newest
  one and no installed build sees it. A re-dispatch of an existing tag is exempt, since that tag is
  already published.

A refusal names the newest tag; re-dispatch with `version_suffix` set above it
(`gh workflow run fork-release.yml --ref main -f version_suffix=np.42`).

Once `MAC_CERTS` exists the workflow switches itself to the signed, hardened, notarized path. There
is nothing else to change.

## Release notes — read the draft before it goes live

The body is generated, not written: `.github/scripts/fork-release-notes.mjs` runs in the
`release-draft` job and fills the `{{CHANGE_SUMMARY}}` placeholder in `.github/fork-release-notes.md`, which holds the static
install and project sections. Nothing about the notes is hand-maintained per release, because a
hand-written "worth knowing" list is what made these releases read as install instructions with no
list of changes.

Where the summary comes from:

- `git log <previous -np. tag>..HEAD` — every commit in the range, grouped as features, fixes,
  performance, refactors, `local(...)` fork patches, docs, tests, other, maintenance. Product
  changes lead because that is what a reader came for; the fork-patch group is why this build differs
  from upstream's, kept after them so it cannot bury them.
- **Patch-equivalent commits are excluded before anything is counted.** This branch is rebased onto
  upstream, so most of a range is commits the previous release already shipped, replayed under new
  shas with identical patches. `git cherry <previous tag> HEAD` is what decides — git's own
  equivalence check, not a subject comparison — and the opening paragraph says how many the range
  held and how many of those the previous release already contains (the `rangeTotal` and
  `alreadyInPrev` in the lead; on 2026-10-06 that read "613 commits changed since the last release
  (716 commits are in the range; 103 of them are already in that release as rebased copies)").
  Check the two numbers against `git log --oneline <prev>..HEAD | wc -l` and
  `git cherry <prev> HEAD | grep -c '^-'` before believing the notes.
- Merges are reported in the opening paragraph rather than as bullets; the commits they brought in
  appear in the groups.
- Product groups print at most 12 entries (`--max-per-group`) and then `+N more`. The fork-patch
  group is capped at 6 (`FORK_PATCH_LIMIT`), because sync and release-record commits are most of it
  and the useful part of that group is that it is named at all. Maintenance, CI, and `docs(fork)`
  fork bookkeeping collapse to a single counted line instead of twelve bullets. Trailing PR numbers
  are stripped, and repeated subjects collapse to `(xN)`.
- The previous tag is the newest `v*-np.*` tag that is neither this build nor a later one, so a rebase
  that leaves the previous tag off `HEAD`'s line does not matter.

**Why the checkout fetches full history:** the summary needs `git log` over the range, and the default
one-commit clone has neither the commits nor the tags. It is a full clone of this repository (a few
minutes on the runner), which is the price of a range that spans a rebase; do not lower `fetch-depth`
in the `release-draft` job to speed it up. (The legs do not read history, so they keep the one-commit
clone — that is two to three minutes off `macos`, the longest leg.) The generator detects a shallow checkout and refuses to guess, which
would leave every future release without a summary.

**The generator cannot fail the release; the workflow does.** No history, a tag that does not exist,
or a shallow clone produces a warning, a body without a summary, and exit 0 — the generator keeps no
veto. `.github/scripts/fork-release-notes-guard.mjs` is the gate instead, and it runs twice: on the
generated body in the `release-draft` job, and again on the draft's live body in the `publish` job
immediately before `--draft=false`. It refuses a body with no `## What changed` heading, one carrying the
generator's own "A change summary could not be generated" fallback, and one under 400 bytes. Until
2026-10-29 the macos job published a minimal `Built from <sha>` body instead of failing, so a
summary-less release went live whenever the generator could not produce one.

**Read the body of the draft before publishing.** The release is created as a draft and only
`gh release edit --draft=false` at the end of the `publish` job makes it public, which is the window for
exactly this check — and the guard above is what now refuses a body with no summary. **A release does
not go public without the change summary**: the body must carry `## What changed` for the range since
the previous `-np.` tag. When the guard refuses, nothing has gone public, and what to do next depends
on which of its two sites refused:

- **The generated notes (`release-draft` job).** It fails before a draft, a tag or an asset exists, so the
  cause is the only thing to fix and a fresh dispatch is the recovery. The generator's warning is in
  the same step's log; a shallow clone is the usual cause. (A _missing previous tag_ is not — the
  generator warns and summarizes from the tip, and that body passes.)
- **The draft's body (`publish` job).** The release stays a draft, which no installed build can see. The
  body to fix is the draft's own: `gh release edit v<version> --notes-file notes.md`, or delete the
  draft and start over. **A re-dispatch does not rewrite it** — an existing draft skips
  `gh release create`, so a re-run re-checks the same body and refuses again.

An install-only body is the failure the generator replaced, not an acceptable fallback.

Reading the draft is still worth doing, because the guard proves a summary _exists_, not that it is
right — a generator bug or a mis-resolved previous tag is exactly what a reader catches and no check
can. A body that is present but wrong is an edit, not a refusal — `gh release edit v<version>
--notes-file notes.md` — and the `publish` job's check runs on whatever the body then says.

```bash
gh release view v<version> --repo nplez1/orca --json body --jq .body | less
```

To check it against git before reading prose — the numbers must agree:

```bash
prev=$(git tag -l 'v*-np.*' --sort=-creatordate | head -1)
git log --oneline "$prev"..HEAD | wc -l          # commits in the range
git cherry "$prev" HEAD | grep -c '^-'           # of those, already shipped by that release
```

What to look for: the summary is present and starts with the features and fixes; the headline count
matches what `git cherry` says the previous release does not already contain; the comparison link is
`<previous tag>...<this tag>` and is not broken; the install table names the version being released;
the signing paragraph matches this run (the macos job warns `Unsigned build` when it is not signing). If the
body is wrong, edit the release (`gh release edit v<version> --notes-file notes.md`) before flipping it
public — or leave it as a draft and delete it, since an installed build cannot see a draft.

To preview locally before a release, or after trimming `.github/fork-release-notes.md`:

```bash
node .github/scripts/fork-release-notes.mjs --version 1.4.214-np.17 --signing unsigned \
  | less          # add --prev-tag vX.Y.Z-np.N to compare against a tag other than the newest
```

## Step 3 — install on each machine

1. **Back up Orca NP state first.** This build is its own identity — bundle id
   `com.nplez1.orca`, product name `Orca NP`, home directory `~/.orca-np`, packaged userData
   `appData/orca-np`, CLI `orca-np` — so it installs _beside_ an official Orca rather than replacing
   it, and the two keep separate state. (The `orca://` URL scheme is deliberately shared: it is
   pairing and skill-share interop, not plumbing.) The backup is still worth taking: a bug in this
   build can damage the state this build owns.
2. **Copy the artifact by `scp` or USB, not a browser.** Only browser/Mail/AirDrop downloads get the
   quarantine bit; a direct copy needs no Gatekeeper override. Notarized builds avoid this anyway,
   but it costs nothing.
3. Confirm the installed version, e.g. `defaults read "/Applications/Orca NP.app/Contents/Info.plist"
   CFBundleShortVersionString`, and that `/usr/local/bin/orca-np` resolves.

## Step 4 — prove the update path

One release cannot demonstrate an update: the check compares the installed version against the newest
release tag, so the first release has no predecessor. Publish a second, trivial release and confirm
each machine moves to it on its own.

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref main
gh release list --repo nplez1/orca --limit 5
```

Then check a machine: the app should report the newer version without a manual install. On macOS the
swap goes through Squirrel, which is why every update must be signed by the same identity.

## Known limits, deliberately accepted

- **Unsigned → signed is a one-way manual step per machine.** Squirrel validates an update against
  the running app's designated requirement; an unsigned build's is its own hash, so the first signed
  update is refused. This is the reason to sign before the first deployment rather than after.
- **Before signing, every macOS update resets privacy grants** — file access under `~/Documents`,
  `~/Desktop`, `~/Downloads` fails with EPERM and no re-prompt. Not an issue once notarized.
- **Windows is unsigned by choice:** SmartScreen warns once per installer, and updates work. Check
  whether Smart App Control is enabled on that machine, because it blocks unsigned apps outright.
- **Fork builds send no diagnostics.** `ORCA_DIAGNOSTICS_TOKEN_URL` stays `null` in builds this
  workflow produces, so the upload handler reports "endpoint not configured" rather than posting.
- **Fork builds are publicly downloadable**, since the fork is public. Harmless — so is the source.

## Checking it is actually working

```bash
# the feed this fork's builds read
curl -s https://github.com/nplez1/orca/releases.atom | grep -o '<title>[^<]*' | head -5

# what the fork has published
gh release list --repo nplez1/orca --limit 5

# what the newest release says changed (a body without a summary means the generator warned; the
# run log has the reason)
gh release view --repo nplez1/orca --json tagName,body --jq '"\(.tagName)\n\(.body)"' | head -30

# do the installed builds still point at this fork after the local patch series moves?
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
```

## When a leg fails: retry, do not re-cut

A run can fail _after_ it has uploaded something — a notarization stapling timeout at Apple's ticket
service (error 68, "The network connection was lost"), or any lost connection. The version does not
change on a re-run: `github.run_number` stays the same across attempts, so a re-run republishes the
same `-np.<n>` tag into the same draft.

**Why the legs run in parallel (2026-11-16).** They used to be serialized (`windows` after `macos`,
`linux` after `windows`) because the draft was created inside `macos`, and electron-builder's GitHub
publisher creates the release itself when its listing finds none for the tag — two legs that both
missed it would each create one. Now `release-draft` creates the draft, with its body, before any leg
starts; a publisher that finds a draft always appends to it (electron-publish
`GitHubPublisher.getOrCreateRelease`), so there is no create decision left to race. `publish` waits for
all three legs, confirms exactly one release carries the tag and that `latest-mac.yml`, `latest.yml`
and `latest-linux.yml` are all on it, re-checks the body and the guard, and only then undrafts. On
v1.4.214-np.56 that is ~26 minutes of legs instead of 44.

**A re-upload of an existing name is handled by electron-builder itself**: on
`422 ReleaseAsset already_exists` it deletes the asset and uploads again (electron-publish 26.15.3,
`gitHubPublisher.js:153-154` → `overwriteArtifact`, `:114-125`). It finds the asset by exact name, so
it only works for names GitHub does not rewrite — on np.38 the mac blockmap was uploaded as
`Orca NP-…` and stored as `Orca.NP-…`, the overwrite never found it, and the retry died on
`already_exists`. `mac.artifactName` in `config/electron-builder.np.config.cjs` keeps every name
GitHub-safe since.

Until 2026-11-16 each leg also ran a `.github/actions/clear-release-assets` step before packaging. It
never cleared anything: its patterns were written `latest\\.yml`, which `grep -E` reads as a literal
backslash, so np.56's retry logged `cleared 0 asset(s)`. It was deleted rather than repaired, because a
working one would delete a published release's live manifests before electron-builder skipped the
upload to it. Before a leg uploads, it now checks that its release is still a draft
(`.github/scripts/fork-release-require-draft.sh`), so a leg re-run on its own (`Re-run job`, or
`--failed` after the draft was deleted) refuses instead of creating a second release or passing on the
assets already there.

**`--failed` is a legitimate retry now:**

```bash
gh run rerun <run-id> --failed --repo nplez1/orca   # the failed leg(s) and `publish`; nothing else
gh run rerun <run-id> --repo nplez1/orca            # everything, gates included — never needed for a leg
```

Releases share one concurrency group (`fork-release`, never cancelled in progress), and GitHub keeps
at most one run _pending_ in it: anything queued behind a pending run — a dispatch, a `keep_draft`
validation, a `--failed` re-run — cancels that pending run. Queue nothing behind a release that is
already waiting.

It re-runs only the failed jobs and their dependents, so a failed `macos` re-runs `macos` and
`publish`, and keeps the gates, the draft and the legs that passed. That used to be unsafe because
`release-ref` — the version guard — is one of the jobs it keeps, and the published tags can move
between attempts. What made it safe is that `publish` runs `fork-release-ref-guard.sh` again
immediately before the undraft, and the guard now holds a **draft** to the newest published `-np.` tag
too (only an already-published tag is exempt, because it cannot be above itself). The ref, the commit,
the inputs and the gate verdicts belong to the run and cannot change between attempts; the tags are
the one input that can, and they are re-read where they matter.

A re-dispatch into an **already-published** tag is refused by `release-draft`: under
`releaseType: draft` electron-builder skips the upload to a release that is not a draft (warning,
exit 0), so the legs would replace nothing. Dispatch a new version instead.

**When `publish`'s guard refuses because a newer `-np.` tag was published since this run's draft**,
the draft can never go public: the newer tag stays newer, so `--failed` (or any re-run) refuses again,
forever. Delete the draft and dispatch a new version:

```bash
gh release delete v<version> --repo nplez1/orca --yes   # a draft has no tag to clean up
node local/dispatch-release.mjs
```

Delete the draft and start over (`gh release delete v<version> --yes`) only when the _draft body_ is
wrong — a re-run keeps the body it created. **After deleting a draft, the next run must be a full
`gh run rerun <id>` or a fresh dispatch, never `--failed` or a single re-run job:** only
`release-draft` creates the draft, and `--failed` keeps the `release-draft` that passed. Every leg
then refuses at "Require this run's draft release" — which is the guard working, not a new failure.

## The Linux leg, first run (2026-10-21, `v1.4.214-np.38`)

The first release to carry Linux x64 built clean on GitHub's ubuntu-latest: AppImage, `.deb` and
`.rpm`, plus `latest-linux.yml`. What the artifact itself confirms, checked against the upload rather
than the config:

- the glibc floor gate runs inside `afterPack` and passed on **21 bundled native binaries**
  (`[verify-linux-glibc-floor] OK — Ubuntu 20.04 / glibc 2.31 / GLIBCXX_3.4.28`);
- the payload is `/opt/Orca NP/orca-ide` + `resources/bin/orca-ide` + `chrome-sandbox`;
- the packages are `orca-np` (`orca-np_<version>_amd64.deb`, `orca-np-<version>.x86_64.rpm`), so
  installing one does not replace an official Orca install;
- `postinst` creates `/usr/bin/orca-np` → the bundled launcher and `chmod 4755`s `chrome-sandbox`;
  `postrm` removes the link only when it points into an Orca NP install;
- `latest-linux.yml` names the AppImage with its blockmap, which is what makes an installed AppImage
  see the release at all. Only the AppImage self-updates; the notes say so for deb/rpm.

**Still unverified, needs one Linux desktop:** `StartupWMClass=orca` in the shipped desktop entry.
The WM class comes from the running app rather than the package name, and this build's product name is
`Orca NP`, so confirm on a real desktop that the launcher groups instead of showing a second icon:

```bash
xprop WM_CLASS     # click the running window; the fix is linux.desktop.entry.StartupWMClass
```
