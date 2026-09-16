**Orca NP `{{VERSION}}`** — Orca built from [`nplez1/orca`](https://github.com/nplez1/orca), on this
fork's own update feed.

Built from [`{{SHA}}`](https://github.com/nplez1/orca/commit/{{SHA}}) on {{DATE}}.

## Install

| Platform | Artifact | How |
| --- | --- | --- |
| macOS, Apple silicon | `Orca-NP-{{VERSION}}-arm64-mac.zip` | unzip, drag **Orca NP** into Applications |
| macOS, Intel | `Orca-NP-{{VERSION}}-mac.zip` | same app, x64 build |
| Windows | `orca-windows-setup.exe` | run it; SmartScreen warns once — *More info* → *Run anyway* |

The `.dmg` and the `.zip` contain the same app; either works.

{{SIGNING}}

## What this build is

- Ships as **Orca NP**, so it installs *beside* an official Orca rather than replacing it: its own app
  bundle, its own data (`Application Support/orca-np`), its own settings (`~/.orca-np`), and its own
  command (`orca-np`).
- Updates from **this repository's releases**, never from stablyai's.
- Sends no diagnostics or usage data.

## First run

- It starts with a **fresh profile**. It cannot read an official Orca install's repos, worktrees,
  credentials or paired devices — that separation is deliberate, not a migration failure.
- macOS asks for **folder permissions again** (Documents, Desktop, Downloads, and any folder you
  grant). Permissions are anchored to the app's identity, so this happens once and then survives
  later updates.
- Add the `orca-np` command to your PATH from **Settings → CLI** if you want it in a terminal.

## Worth knowing

- `orca://` is intentionally shared with official Orca, so pairing links and skill-share links work
  in both. On a machine with both installed, macOS routes `orca://` to only one of them.
- The Windows build is unsigned by choice: one SmartScreen warning per installer, after which
  self-updates work. If Smart App Control is enabled it refuses unsigned apps outright.
