<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Latest Orca NP release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Orca NP builds: macOS and Windows" />
</p>

<p align="center">
  <sub><a href="docs/readme/README.zh-CN.md">中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a> · <a href="docs/readme/README.es.md">Español</a> · <a href="docs/readme/README.fr.md">Français</a> · <a href="docs/readme/README.pt.md">Português</a> · <a href="docs/readme/README.tr.md">Türkçe</a> · <a href="docs/readme/README.ru.md">Русский</a></sub>
</p>

<p align="center">
  <strong>🔱 This is <a href="#whats-different-in-this-fork">Orca NP</a> — a fork of <a href="https://github.com/stablyai/orca">stablyai/orca</a> with its own features, fixes, and releases.</strong><br/>
  <sub>Installs beside the official Orca · <a href="https://github.com/nplez1/orca/releases/latest">Download the latest Orca NP build</a> · <a href="#whats-different-in-this-fork">See what's different ↓</a></sub>
</p>

<p align="center">
  <strong>The AI Orchestrator for 100x builders.</strong><br/>
  Run Codex, ClaudeCode, OpenCode or Pi side-by-side — each in its own worktree, tracked in one place.
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Download Orca NP</ins></a></h3>

<p align="center">
  <img src="docs/assets/readme-hero.jpg" alt="Orca desktop app running agents in parallel worktrees, with the Orca mobile companion app in the corner" width="960" />
</p>

## What's different in this fork

Orca NP is [stablyai/orca](https://github.com/stablyai/orca) plus a series of fork-only features and fixes. The upstream feature list below still applies (except where a build isn't published here — see [Install](#install)); this is what Orca NP adds on top. The full list is in the [merged pull requests](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged), and the fork-only patch series is documented in [`LOCAL-PATCHES.md`](LOCAL-PATCHES.md).

### Tasks, issues, and Jira

- **Jira board view** — pick a default board and the Jira tab shows columns, the active sprint, and the backlog, with drag-to-move between columns, a filter box, and priority colors.
- **Lane drops that stick** — dropping a Jira item on a lane resolves the transition, asks for the fields that transition's screen requires, and moves the card before Jira confirms it, rolling back only if Jira refuses.
- **Sprints, story points, and custom fields** — move a backlog item onto a sprint from its row or the issue drawer, set or clear story points beside status, priority, and assignee, and edit custom user-picker fields (Dev, QE) from the issue detail. A sprint change made in the open issue reloads the board.
- **"Me" matches every role field** — an issue where you are the Dev or the QE, not only the assignee, now appears under the board's Me filter.
- **Searchable assignee picker** — with you and your team pinned to the top.
- **Linked issue in the right sidebar** — a workspace created from a Jira, Linear, or GitHub issue gets an Issue tab with status, assignee, priority, labels, description, and an Open button. Jira issues also get unlink/re-link, a live Markdown comment box, and correct rendering of self-hosted Jira (Server/Data Center) descriptions. A GitHub issue is read from the repo it came from, so a workspace in another project still loads it, and when that repo is not on this machine, the tab says so instead of failing.
- **Link a workspace to a Jira issue** by key or URL from its details dialog; the Tasks page shows an attached-workspace chip and opens the existing workspace instead of creating a duplicate.

### Pull request review and CI

- **Inline GitHub PR comments** — comments appear under their line in the editor, with reply, resolve, and collapse (shown only when your checkout matches the PR's head commit).
- **Merge readiness at a glance** — the PR icon keeps its CI color and adds a dot for outstanding approvals, conflicts, or blocks, with the reason in the tooltip. Works across GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea.
- **Review verdicts in the Checks panel** — Approved / Changes requested with reviewer names, and the panel updates when CI changes instead of waiting for a tab switch.
- **A live Checks panel** — while a run is in flight an open panel refreshes every 10s instead of waiting out the review cadence, slowing to 20s and then 30s while nothing changes, and its verdict updates the sidebar card and activity-bar icons (GitHub).
- **Jenkins build details** — expand a Jenkins check to see its stages, which one is running or failed, and the build facts.
- **Admin merge for review-gated PRs** — if your account may bypass branch protection, Merge is offered after a confirmation that names what gets skipped.

### Agents

- **Session summaries** — a written brief of an agent session (activity, goal, plan, blockers, timeline) in the right sidebar, with its own agent/model setting. Covers Pi, Copilot, OpenCode, and Cursor sessions as well; a session on a paired host is briefed on that host, and one on an SSH target is briefed from its streamed transcript.
- **More accurate agent status** — Pi rows no longer stick on "Working" or turn "Done" when a helper sub-agent finishes; Copilot CLI no longer raises "needs you" for auto-approved prompts; a Grok sub-agent waiting on you keeps its row waiting; a pane restored on another client drops the needs-input marker its dialog left behind; and a Claude sub-agent a pi session launches through the `claude` CLI stays on the pi session's row (needs a current pi-subagents plugin).
- **Copilot's prompts are read from the screen** — a shell or URL approval and the "Copilot needs information" dialog show as prompts instead of a spinner, while a permission the CLI approved on its own stays quiet.
- **Focus stays in the agent tab** — clicking a sidebar card, a right-sidebar activity tab, or the panel background hands the keyboard back to the agent tab, and closing a menu or dialog returns the caret too, so the next keystroke still means what it did.
- **Clipboard follows the reader** — a copy from a pi pane watched from a paired client lands in that client's clipboard as well as the host's.
- **One-click default agent** — the `+` button in the tab bar launches your default agent; hold it or use the chevron for the full menu.
- **Agent Dashboard as a page** — opens in the main window with back/forward, and clicking a card opens that agent's workspace.
- **Agent session history** — "All" really lists every session, sub-agent sessions nest under their parent, and transcript indexing makes existing transcripts searchable. A paired host's history loads in pages and refreshes only what changed, so a large remote history arrives instead of failing.
- **Usage tracking for more providers** — Copilot enterprise AI-credit budgets, DeepSeek balance, and Fireworks.ai spend in the status bar, plus a per-provider off switch that stops polling and credential reads. An expired Claude login is refreshed from the stored refresh token rather than sitting at "Updates when Claude runs", and the renewed login is saved back where Claude keeps it.

### Workspaces and layout

- **One folder per project** — the main checkout and all its worktrees live together under one folder with a shared `AGENTS.md`; `orca repo relocate` moves existing checkouts into it.
- **Grouped workspaces across machines** — the same branch on two hosts becomes one card with a host dropdown. A workspace on a paired host reads its GitHub issue and PR from that host, and its status dot stops spinning once the host's agents finish.
- **Paired clients stay in step** — projects and workspaces a host adds or removes, including ones created in that host's own window or from its CLI, reach its paired clients without a manual refresh.
- **Status filter** — hide chosen statuses from the sidebar and Cmd+J while the board still shows everything.
- **"Setting up…" indicator** while a repo's setup script runs, including for workspaces started without an agent.
- **Shared-directory modes** — symlink, APFS clone, copy, or skip for directories shared between worktrees.
- **Floating workspace** — a home folder of its own, a drag handle on the titlebar, and the same agent launch control as the main tab bar.
- **Hide auto-imported SSH hosts** from pickers and the status bar; hidden hosts stay listed under Settings.
- **Faster, honest file filter** — the Explore filename filter searches the whole workspace from a prebuilt index and says so when results are partial instead of "no files match".
- **Host settings replication** _(groundwork)_ — one machine's settings and provider credentials can be replicated to paired hosts.

### Ephemeral environments

Additions to upstream's per-workspace environment recipes (Settings → Experimental → Cloud VM):

- **Lease countdown and Extend** — a recipe that publishes when the provider takes the host away gets a countdown on the workspace card and in Settings, and, when it also declares how to extend, an Extend action limited to the lifetimes it lists. Past the deadline the card and Settings show the lease as expired; once a further 15 minutes have passed and Orca's connection to the host has failed, Orca removes the workspace from its list, and the provider's machine is left to its own expiry or to Cleanup in Settings.
- **Recipe-declared context-menu items** — up to 20 actions a recipe declares get their own entries in that workspace's context menu and run with the workspace's host, name, and path. They are declared in `orca.yaml`, so they are covered by the recipe's approval, and a recipe that declares none adds no entries.

### Reliability

- Git hooks and ssh-agent auth work when the packaged app is launched from the Dock, because git now sees the exports from your shell profile.
- macOS computer-use permissions no longer split across two helper identities.
- Right-click paste into Copilot CLI pastes once, not twice.
- An opt-in "Log UI hangs" diagnostic writes stall records, with focus, sleep, and CPU context, to help track down beachballs.

### Running it

- **Own identity** — Orca NP uses its own app id (`com.nplez1.orca`), data directory, home directory (`~/.orca-np`), and CLI (`orca-np`), so it installs and runs beside an official Orca without sharing state.
- **Own releases and updates** — builds are tagged `v<upstream version>-np.<n>` and the in-app updater follows [this repository's releases](https://github.com/nplez1/orca/releases), not upstream's.
- **Signing** — macOS builds are signed and notarized; the Windows installer is unsigned, so SmartScreen warns once on install.
- **No telemetry** — the release notes state that builds send no diagnostics or usage data.
- **Skills point at this app** — bundled skills and the published stubs call `orca-np` (and `orca-np-dev` in development) rather than falling through to an official install's `orca`.
- **Fresh profile** — Orca NP cannot read an official Orca install's repos, credentials, or paired devices; that separation is deliberate, so pair your phone with Orca NP separately.
- **Tracks upstream** — upstream `main` is merged in regularly (the procedure is in [`UPSTREAM-SYNC-RUNBOOK.md`](UPSTREAM-SYNC-RUNBOOK.md)), so the fork receives upstream features and fixes too.

---

## Features

The feature wall below is upstream Orca's; its "Docs" links go to upstream's documentation at onorca.dev, which doesn't cover the fork-only features above.

<table>
<tr>
<td width="50%" valign="middle">

### Mobile Companion

Monitor and steer your agents from your phone — get notified when an agent finishes and send follow-ups from anywhere.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://www.onorca.dev/download/android) · [Docs →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="docs/assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="docs/assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca desktop with the mobile companion app" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Parallel Worktrees

Fan one prompt across five agents, each in its own isolated git worktree — compare the results and merge the winner.

[Docs →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="docs/site/public/docs/tab-split.gif" type="image/gif"><img src="docs/site/public/docs/posters/tab-split.jpg" alt="Parallel worktree orchestration" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminal Splits

Ghostty-class terminals with WebGL rendering, infinite splits, and scrollback that survives restarts.

[Docs →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Terminal splits" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Design Mode

Click any UI element in a real Chromium window to send its HTML, CSS, and a cropped screenshot straight into your agent's prompt.

[Docs →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="docs/site/public/docs/orca-design-mode.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Embedded browser and Design Mode" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear, Native

Browse PRs, issues, and project boards in-app — open a worktree from any task and review without a context switch.

[Docs →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="resources/onboarding/feature-wall/tile-03.poster.jpg" alt="GitHub and Linear task workflows in Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktrees

Run agents on a beefy remote box with full file editing, git, and terminals — auto-reconnect and port forwarding included.

[Docs →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Remote worktrees over SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Annotate AI Diffs

Drop comments on any diff line and ship them back to the agent — review, edit, and commit without leaving Orca.

[Docs →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="docs/site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Annotate AI-generated diffs" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Drag Files to Agents

VS Code's editor with autosave everywhere — drag files or images straight into an agent prompt.

[Docs →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Drag files and images into an agent prompt" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Agents drive Orca too — script every workflow with `orca worktree create`, `snapshot`, `click`, and `fill`.

[Docs →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Script Orca from the CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Also in the box:**

- **[Quick open](https://www.onorca.dev/docs/model/quick-open)** — Search across worktrees, files, agents, commands, and repo context without leaving your flow.
- **[Account switcher &amp; usage tracking](https://www.onorca.dev/docs/agents/usage-tracking)** — See Claude and Codex usage and rate-limit resets, and hot-swap accounts without re-logging in.
- **[Rich repo previews](https://www.onorca.dev/docs/editing/markdown)** — Preview Markdown, images, PDFs, and repo docs in the workspace.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Let agents operate desktop apps and visible UI when a workflow needs real interaction.
- **[Notifications and unread state](https://www.onorca.dev/docs/notifications)** — Know when an agent finishes or needs attention, then mark threads unread to come back later.
- **And many, many more** — we ship daily, so this list is perpetually behind. The [Orca NP releases](https://github.com/nplez1/orca/releases) are the real feature list for this fork, and [upstream's](https://github.com/stablyai/orca/releases) for everything it inherits.

---

## Supported Agents

Works with **any CLI agent** — if it runs in a terminal, it runs in Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="docs/assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="MiMo Code logo" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuddy.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.ai&sz=64" alt="CodeBuddy logo" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com"><kbd><img src="src/shared/agent-icons/freebuff.png" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="docs/assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

---

## Install

### Desktop — macOS, Windows, Linux

- **[Download the latest Orca NP release](https://github.com/nplez1/orca/releases/latest)**
- Or grab a build directly: [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [Linux (AppImage)](https://github.com/nplez1/orca/releases/latest/download/orca-linux.AppImage) · [All builds](https://github.com/nplez1/orca/releases)

Orca NP installs beside an official Orca and updates itself from this repository's releases. The
Linux build is x86_64 only: the AppImage updates itself, while the `.deb` and `.rpm` install the same
app under a package manager and are updated by installing a newer release. This fork does not publish
a Homebrew/AUR package.

### Mobile Companion — iOS, Android

Pair the Orca mobile app with Orca NP to monitor and steer your agents from your phone. The apps are published by upstream Orca and work with Orca NP.

- **iOS:** [Download on the App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Download APK](https://www.onorca.dev/download/android) · [Install guide](https://www.onorca.dev/docs/android-apk)

---

## Community &amp; Support

- **Orca NP issues &amp; ideas:** [Open an issue](https://github.com/nplez1/orca/issues) for anything specific to this fork.
- **Upstream community:** upstream Orca's channels cover everything this fork inherits — [Discord](https://discord.gg/fzjDKHxv8Q), [@orca_build on X](https://x.com/orca_build), and [upstream issues](https://github.com/stablyai/orca/issues) for bugs that also reproduce in official Orca.
- **Upstream WeChat group:** group 12 is full. Scan to join Orca community WeChat group 13.

  <img src="docs/assets/wechat-qr.jpg" alt="WeChat QR code for the Orca community" width="160" />

- **Docs:** [onorca.dev/docs](https://www.onorca.dev/docs) documents upstream Orca.
- **Show support:** [Star](https://github.com/nplez1/orca) this repo to follow the fork, or [upstream](https://github.com/stablyai/orca).

---

## Developing

Want to contribute or run locally? See our [CONTRIBUTING.md](.github/CONTRIBUTING.md) guide.

The relay that pairs the mobile app with a desktop host is also in this repository under
[`cloud/`](cloud/README.md), with a separate pnpm workspace and setup guide.

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Orca NP contributors" />
</a>

## Signed Builds

Orca NP's Windows installer is unsigned. Upstream Orca's Windows builds are signed with code signing sponsored by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## License

Orca is free and open source under the [MIT License](LICENSE).
