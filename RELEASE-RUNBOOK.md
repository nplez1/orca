# Release runbook

How to go from "certificate approved" to "four machines running my fork on my own update channel".
Everything here is fork-only; none of it touches upstream.

Companions: [BRANCHES.md](./BRANCHES.md) for branch state, [LOCAL-PATCHES.md](./LOCAL-PATCHES.md)
for the fork-only patches the builds depend on, and
[UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md) for the sync that usually precedes a
release. Bring upstream in first — a release built from a stale base cannot see the fixes upstream
has since landed.

## What is already done

- Update feed re-pointed to `nplez1/orca` (six references) — the reason a build of this fork updates
  from this fork instead of being offered an official release.
- `publisherName` dropped, so unsigned Windows installers update themselves.
- `.github/workflows/fork-release.yml` registered and active.
- Actions enabled on the fork; `nplez1/main` is the default branch, which is what makes a
  `workflow_dispatch` workflow runnable at all. That is repository state, not tree state — a merge can
  flip it back, so re-check it after every merge (Step 0.5).
- Pushing works over `ssh://git@ssh.github.com:443/...` (port 22 is blocked on this network).

## Step 0 — validate the pipeline unsigned first (already done; skip unless the workflow changes)

**Why:** if you set the certificate first and the run fails, you cannot tell a pipeline bug from a
signing bug. Run it once with no secrets — nothing gets deployed, and a green run proves the build,
the publish, and the `latest-mac.yml` / `latest.yml` manifests.

This step is **complete** — the pipeline ran unsigned on 2026-09-16 and has published every release
from np.6 to np.11 since, so the only reason to repeat it is a change to `fork-release.yml` itself.

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main
gh run watch --repo nplez1/orca
```

A published release should appear with `latest-mac.yml`, the `.zip`, the `.dmg`, `latest.yml`, and
`orca-windows-setup.exe`, and a body that opens with a generated change summary (see
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

Check the nightly before cutting, not after:

```bash
gh run list --workflow fork-main-tests.yml -L1 --repo nplez1/orca
```

A red there is a failure the Mac's allowlist cannot see, because the Linux runner has its own red set.
Triage it first. If that nightly is green on the exact commit being released, record it in the release
notes — it covers the Linux runtime better than the local gate does, though the local gate is still
the only one that exercises the darwin-bound classes, so substituting it is a judgement call and not
something to do silently.

Since 2026-10-29 the dispatch carries the same coverage itself: `fork-release.yml` runs the unit suite
on the dispatched commit (`unit-plan` → `unit-tests`, the same reusable workflow, shard plan and fork
shard verdict as the nightly) and every artifact leg waits for it. So a dispatch can no longer publish
with no test evidence, and there is no flag to skip it. If a shard is red there, the fix is the one
above — fix it, or classify it in `local/nightly-linux-known-red.json` with evidence — not a retry.

## Step 2 — publish the first signed release

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main
```

The version is stamped `<package.json version>-np.<run number>` by the workflow. That suffix matters
twice: it keeps fork releases strictly newer than each other, and it makes a fork build identifiable
if someone reports a bug — upstream has never shipped that version.

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
(`gh workflow run fork-release.yml --ref nplez1/main -f version_suffix=np.42`).

Once `MAC_CERTS` exists the workflow switches itself to the signed, hardened, notarized path. There
is nothing else to change.

## Release notes — read the draft before it goes live

The body is generated, not written: `.github/scripts/fork-release-notes.mjs` runs in the macos job and
fills the `{{CHANGE_SUMMARY}}` placeholder in `.github/fork-release-notes.md`, which holds the static
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
in the macos job to speed it up. The generator detects a shallow checkout and refuses to guess, which
would leave every future release without a summary.

**The generator cannot fail the release; the workflow does.** No history, a tag that does not exist,
or a shallow clone produces a warning, a body without a summary, and exit 0 — the generator keeps no
veto. `.github/scripts/fork-release-notes-guard.mjs` is the gate instead, and it runs twice: on the
generated body in the macos job, and again on the draft's live body in the linux job immediately
before `--draft=false`. It refuses a body with no `## What changed` heading, one carrying the
generator's own "A change summary could not be generated" fallback, and one under 400 bytes. Until
2026-10-29 the macos job published a minimal `Built from <sha>` body instead of failing, so a
summary-less release went live whenever the generator could not produce one.

**Read the body of the draft before publishing.** The release is created as a draft and only
`gh release edit --draft=false` at the end of the linux job makes it public, which is the window for
exactly this check — and the guard above is what now refuses a body with no summary. **A release does
not go public without the change summary**: the body must carry `## What changed` for the range since
the previous `-np.` tag. A minimal body means the generator did not run, and the run fails before the
draft exists: read its warning in the run log, fix the cause, and re-run the workflow, or write the
notes by hand with `gh release edit v<version> --notes-file notes.md` (the second run then passes the
same guard). An install-only body is the failure the generator replaced, not an acceptable fallback.
Reading the draft is still worth doing, because the guard proves a summary _exists_, not that it is
right — a generator bug or a mis-resolved previous tag is exactly what a reader catches and no check
can.

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
the signing paragraph matches this run (the macos job logs `signed=true` or `signed=false`). If the
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
gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main
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
service (error 68, "The network connection was lost"), or any lost connection. electron-builder
appends to the existing release, so the retry then dies on its own first attempt's asset names:

```
422 Unprocessable Entity — ReleaseAsset: already_exists (field: name)
```

That is not a build problem, and the version does not change: `github.run_number` stays the same
across re-runs, so `gh run rerun <id>` republishes the same `-np.<n>` tag.

**Each leg clears its own assets first** (`.github/actions/clear-release-assets`, called before
"Package and publish" in all three jobs). Each leg passes the extended-regex alternation of the names
it publishes, so re-running one job never deletes another leg's artifacts, and a first attempt is
unchanged because a missing release or no match is a no-op. So:

```bash
gh run rerun <run-id> --repo nplez1/orca     # re-runs every job; failed legs re-upload cleanly
```

Delete the draft and start over (`gh release delete v<version> --yes --cleanup-tag`) only when the
_draft body_ is wrong — a re-run keeps the body it created.

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
