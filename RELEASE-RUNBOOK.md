# Release runbook

How to go from "certificate approved" to "four machines running my fork on my own update channel".
Everything here is fork-only; none of it touches upstream.

Companions: [BRANCHES.md](./BRANCHES.md) for branch state, [LOCAL-PATCHES.md](./LOCAL-PATCHES.md)
for the fork-only patches the builds depend on.

## What is already done

- Update feed re-pointed to `nplez1/orca` (six references) — the reason a build of this fork updates
  from this fork instead of being offered an official release.
- `publisherName` dropped, so unsigned Windows installers update themselves.
- `.github/workflows/fork-release.yml` registered and active.
- Actions enabled on the fork; `nplez1/main` is the default branch, which is what makes a
  `workflow_dispatch` workflow runnable at all.
- Pushing works over `ssh://git@ssh.github.com:443/...` (port 22 is blocked on this network).

## Step 0 — validate the pipeline unsigned first

**Why:** the first CI run has never happened. If you set the certificate first and the run fails, you
cannot tell a pipeline bug from a signing bug. Run it once with no secrets — nothing gets deployed,
and a green run proves the build, the publish, and the `latest-mac.yml` / `latest.yml` manifests.

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main
gh run watch --repo nplez1/orca
```

A published release should appear with `latest-mac.yml`, the `.zip`, the `.dmg`, `latest.yml`, and
`orca-windows-setup.exe`. Keep that release; it is also your rollback artifact.

## Step 1 — the five secrets

Set these on `nplez1/orca` → Settings → Secrets and variables → Actions. Never in the repo.

| Secret | What it is |
|---|---|
| `MAC_CERTS` | base64 of the exported `.p12` — `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERTS_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | the Apple Account email you enrolled with |
| `APPLE_APP_SPECIFIC_PASSWORD` | from account.apple.com → Sign-In & Security → App-specific passwords |
| `APPLE_TEAM_ID` | Membership details in the developer portal |

The certificate must be **Developer ID Application**, created from a CSR generated in Keychain
Access and exported **with its private key**. `config/scripts/verify-macos-release-env.mjs` fails the
run if any of the five is missing, before the build starts.

## Step 2 — publish the first signed release

```bash
gh workflow run fork-release.yml --repo nplez1/orca --ref nplez1/main
```

The version is stamped `1.4.197-np.<run number>` by the workflow. That suffix matters twice: it keeps
fork releases strictly newer than each other, and it makes a fork build identifiable if someone
reports a bug — upstream has never shipped that version.

Once `MAC_CERTS` exists the workflow switches itself to the signed, hardened, notarized path. There
is nothing else to change.

## Step 3 — install on each machine

1. **Back up Orca state first.** The fork build shares `~/Library/Application Support/Orca` and
   `~/.orca` with official Orca — same bundle id, same Keychain identity, same CLI shim — so a
   fork-build bug can damage state you depend on. Installing it also *replaces* official Orca rather
   than sitting beside it.
2. **Copy the artifact by `scp` or USB, not a browser.** Only browser/Mail/AirDrop downloads get the
   quarantine bit; a direct copy needs no Gatekeeper override. Notarized builds avoid this anyway,
   but it costs nothing.
3. Confirm the installed version, e.g. `defaults read /Applications/Orca.app/Contents/Info.plist
   CFBundleShortVersionString`, and that `/usr/local/bin/orca` resolves.

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

# do the installed builds still point at this fork after the local patch series moves?
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
```
