# Local patches on `nplez1/main`

This branch is upstream `main` plus a small, deliberate set of changes that exist **only here**.
They are never proposed upstream, and they must never reach a PR branch.

## Rules

- Local commits use a `local(<area>):` prefix so they stand out in `git log`.
- A local patch may only touch files that **no PR branch owns**. PR branches are cut from
  `origin/main`, never from this branch, so nothing here can leak into a PR — but if a local patch
  touched a file a PR also changes, the fork and the PR would silently disagree about that file.
- Every patch is listed below with its reason and its exact anchors, because upstream edits to those
  lines are the only thing that breaks them.

## Patches

### `local(updater)`: point the update feed at this fork

Upstream hardcodes `stablyai/orca` as the update feed in several places. Left alone, a build of this
fork offers to replace itself with an official release — and because local builds carry a
`-local.<ts>.<sha>` pre-release version, semver comparison treats an official release as newer.

Anchors to re-point (`stablyai/orca` → `nplez1/orca`):

- `src/main/updater-prerelease-feed.ts` — `ATOM_FEED_URL`, `RELEASES_DOWNLOAD_BASE`, `TAG_HREF_RE`,
  and the Windows absolute-asset regex.
- `src/main/updater/updater-setup.ts` — the `latest/download` fallback.
- `src/main/updater/updater-release-feed.ts` — the `latest/download` fallback.
- `src/shared/release-channel.ts` — `MAIN_RELEASE_REPO`.

`HOURLY_/DAILY_/ADHOC_RELEASE_REPO` deliberately still name upstream's channel repos: those release
channels are unused here, and re-pointing them would only invite confusion.

### `local(build)`: do not bake an updater `publisherName` into Windows builds

This fork ships unsigned. `electron-updater` Authenticode-verifies every installer it downloads
against the `publisherName` recorded in the installed app's `app-update.yml`, and an installer whose
publisher does not match is rejected — including its own channel's next build. Upstream sets
`SignPath Foundation` for non-dev channels. Here it is dropped and `verifyUpdateCodeSignature` is
disabled, which is the same thing upstream's dev channels do for the same reason.

Anchor: `config/electron-builder.config.cjs`, `win.signtoolOptions`.

### `local(dev)`: rebuild-and-relaunch helper

`package.json`'s `rebuild:mac:relaunch-installed` script plus
`config/scripts/rebuild-and-relaunch-installed-macos-arm64.sh`: build locally and install over the
running app. Convenience only — not for upstream.

## Syncing with upstream

```bash
git fetch origin
git rebase origin/main
```

The local commits replay on top. Because each patch is a one-line constant edit, a conflict here
means upstream moved that exact line — re-apply by hand and amend that commit rather than resolving
mechanically.

After a sync, confirm the fork still behaves:

```bash
pnpm typecheck
node -e "require('./config/electron-builder.config.cjs')"   # config still loads
```

Then check the update path still points at this fork:

```bash
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
```

### `local(ci)`: release workflow

`.github/workflows/fork-release.yml` builds macOS and Windows artifacts and publishes them as a
release on this fork — which is the feed the patched updater points at. It exists because every
upstream release workflow is a no-op in a fork (they guard on
`github.repository == 'stablyai/orca'`) and publishes to stablyai's separate channel repos. It is
`workflow_dispatch` only, so it never runs on its own.

It builds on GitHub-hosted runners (`macos-15`, `windows-2022`) rather than upstream's Blacksmith
labels, which belong to stablyai's account. Signing is conditional on `MAC_CERTS` being set, so the
pipeline is usable before a certificate exists and switches to the signed, notarized path by itself
once it does.

Fork-only helper scripts live in `local/`:

- `local/branch-status.mjs` — live status of every branch (SHAs, fork presence, own delta, PR).
