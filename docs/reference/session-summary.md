# Session summary

A **session summary** is a written brief about one agent session: what it is trying to do,
what it has finished, what it is doing right now, what blocks it, and a timeline of
highlights whose entries point back at the transcript message they came from. It exists
so a user returning to a long-running agent does not have to re-read the terminal.

## Where it is surfaced

| Surface | File | Reachable |
| --- | --- | --- |
| Right-sidebar **Summary** tab (`RightSidebarTab` value `summary`) | `src/renderer/src/components/right-sidebar/SessionSummaryPane.tsx` | yes |
| Collapsed strip in the Activity thread detail pane | `src/renderer/src/components/activity/session-summary-panel.tsx` | **no** — see below |

The Activity strip is dead UI today: `ActivityThreadDetailPane` is rendered only by
`ActivityPrototypePage`, which renders only while `activeView === 'activity'`, and the one
caller of `openActivityPage` was deleted when the agent list moved into the left sidebar
as its own tab (`SidebarAgentsList`, upstream #18222). The strip is kept so the pane still
renders correctly if that view returns; the right-sidebar pane is the live surface.

Both hosts render the same body (`components/activity/session-summary-ledger-view.tsx`) and
the same header state (`components/activity/session-summary-presentation.ts`).

## Which session it reports on

`src/renderer/src/components/right-sidebar/session-summary-subject.ts`: the agent pane
**focused in the active workspace**, and nothing else. Clicking an agent row — in the left
sidebar's Agents tab or the Activity list — focuses that pane
(`activity-thread-actions.ts` → `activateTabAndFocusPane`), so a click drives the pane too.

The rule is deliberately strict. Another agent in the same workspace is not this pane's
subject: guessing the most recently active one shows a summary of a session the user is not
looking at, which reads as though it were theirs. An unfocused pane shows the
"Focus an agent session" empty state instead. A subject is a `paneKey`
(`tabId:leafId`), and the pane remounts when it changes, so one session's last-seen cursor
never carries into the next.

A focused **hibernated** pane still qualifies, and that is what makes finished sessions
summarizable. The fold resolves its transcript from a provider session
(`hasSource = entry.agentType && entry.providerSession?.id`), and main keeps a
`providerSessionOnly` remnant row for a dropped status row
(`src/main/agent-hooks/server/server-cleanup.ts`), so a finished agent that still has a pane
to focus folds like a live one. Pinned by `session-summary-service.test.ts` → "summarizes a
finished session from a provider-session remnant row".

## Mechanism

The summary is a **materialized view** over the session's own provider transcript — the JSONL
the agent CLI writes — not a re-reading of the terminal. `session-summary-transcript-source.ts`
resolves that file per agent type; the fold turns it into a structured ledger.

The fold reads a transcript only for agents it can name a file for, and each agent's file is
found a different way:

- **Native-chat agents** (Claude/OpenClaude, Codex, Grok, OMP) go through
  `native-chat/session-file-resolver.ts`, which takes the hook's `transcript_path` when it is
  host-readable and otherwise searches the agent's own roots by session id.
- **Pi and Prime Agent** post `session_file` on every hook, so the reported path *is* the
  transcript; `agent-session-resume.ts` only returns their provider session at all when that
  path exists.
- **Copilot** reports no path, but its `session_id` is the name of its session directory:
  `$COPILOT_HOME/session-state/<id>/events.jsonl`.

Every other agent type returns null and the pane says so. Adding one means naming its parser in
`HOOK_RESOLVED_TRANSCRIPT_AGENTS` and reaching a readable file — the AI Vault parsers are
agent-generic (`parseAgentSessionFile` dispatches on `candidate.agent`), so nothing else changes.

- **Lazy by construction.** Opening the pane starts the fold; closing it cancels in-flight
  work. Nothing runs for sessions nobody opens, so there is no background LLM spend.
- **Cheap facts are always available.** State, timestamps and event counts come from the
  status entry, so the header hint needs no fold. The hint still respects the fold's own state:
  a fold in flight reads "Updating…" (set when the fold starts, not when its first chunk
  returns), and a session with no readable transcript or a failed fold says that instead of
  claiming to be up to date.
- **Bounded, resumable chunks.** The transcript is split deterministically into slices of at
  most 24k chars or 40 events (`session-summary-fold.ts`), extracted in parallel and merged
  deterministically. Completed extracts are cached, so a fold that is cancelled or fails
  resumes instead of restarting.
- **Atomic.** A failed or unparseable chunk keeps the last good ledger and retries next time.
  Completed chunk extracts are kept for that retry only once a fold has produced a ledger —
  an unproduced one is never stored, so a first fold's chunks are lost with it.
- **Delta-first.** Timeline entries are append-only and counted, so a per-session last-seen
  cursor produces the "Since you last looked" section.

The ledger cache is `session-summaries.json` under `userData`, written atomically. It is a
rebuildable cache: deleting it costs one fold per session, never state.

The agent, model, and thinking effort that fold a summary are their own setting —
**Settings → Agents → Session summaries** (`sessionSummaryAi`), which reuses the agent/model
shape the Source Control AI settings use without sharing their value. It is deliberately
separate: a summary is not a source-control action, and borrowing the commit-message recipe
meant summary cost could not be tuned without changing commit messages. Resolution lives in
`src/shared/session-summary-ai.ts` (read by `session-summary-fold-params.ts`); with nothing
configured it follows the default agent and that agent's default model and effort.

A **dynamic** agent ships only a stub model list — Pi advertises `Config default` — so the
pane asks its CLI once (`<binary> --list-models`, the same probe Native Chat uses), keeps the
answer and replaces the stub with it. **Copilot** is dynamic too, but its catalog is only
documented, not listed: the CLI has no `models` subcommand, so the probe reads
`copilot help config`, whose `model` setting enumerates the accepted ids. That list is the CLI's
own and therefore tracks models released after the build, which a pinned array cannot; a machine
without the binary keeps a pinned snapshot of it (`COPILOT_FALLBACK_MODELS`) that the probe
replaces the moment it can run. Two rules matter there:

- **The pane keys on the session, not just the pane.** A new agent session can start in the
  pane the user is already focused on, and the key includes the provider session id so the
  service resets the ledger instead of briefing the previous conversation.
- **The tab only appears where a fold can run.** A paired web client composes no
  `sessionSummary` bridge, so the activity bar omits the tab and the pane says so.
- **Only a real probe is cached.** A result whose `catalogOrigin` is `spec` is the built-in
  list, and caching it would retire the probe for that agent forever.
- **A cached list is refreshable.** The pane offers *Refresh models*, which drops the cached
  probe for the selected agent and lists again; without it, a model the CLI started
  reporting would stay unreachable for the life of the install.
- **Storage is host-keyed; resolution is local.** The pane's model list describes the agent
  CLIs this window can spawn, and it is stored under the host-keyed slots so a host-aware
  resolver needs no migration. It still reads the local slot: a fold the desktop runs uses a
  local CLI, and a fold a paired host runs uses a CLI installed *there*, with the agent and
  model named by the request (see "Which host folds").

## Which host folds

The fold runs wherever the session's transcript lives, so accessing a session remotely
behaves like working on that machine directly.

| Workspace host | Transcript read | Fold (agent CLI) | Ledger, chunk cache, seen cursor |
| --- | --- | --- | --- |
| `local` | local filesystem | this window | local `session-summaries.json` |
| `ssh:<target>` | `cat` over the SSH connection Orca already holds, streamed to a copy | this window | local `session-summaries.json` |
| `runtime:<env>` | the paired host's own filesystem | **the paired host** | the paired host's `session-summaries.json` |

Why it splits that way: a paired Orca server is this same codebase served without Electron
(`orcad-entry.ts`), so it runs its own `SessionSummaryService` and the desktop only relays
its snapshots — `sessionSummary.openOnHost`, `sessionSummary.snapshotOnHost`,
`sessionSummary.closeOnHost` (`src/main/runtime/rpc/methods/session-summary.ts`). A plain SSH
target runs no Orca server at all, only the relay CLI, so its transcript is fetched and
folded here.

- **The client polls a host fold; it does not hold a call open.** A fold of a long session
  outlives a relay idle window, and "still running?" plus "what is the ledger now?" is all
  the pane needs. A reconnect resumes polling the same host state.
- **The request carries the chosen agent.** `foldParams` is resolved from the requesting
  client's Settings → Agents and sent with the open, so a host never spawns an agent the
  reader did not choose. A host without that CLI installed fails the fold with its own
  error rather than substituting one.
- **A paired host that predates these methods** answers `method_not_found`, which the pane
  reports as "Update Orca there to summarize its sessions" — a remedy, not a failed fold.
  Older servers are the normal case, since they update on their own schedule.
- **A request without a usable agent is rejected, not defaulted.** The host folds with the
  agent and model the request names; when it cannot parse them it fails the open rather than
  substituting its own settings, because a summary is the user's own transcript. A host that
  lacks that CLI fails the fold with its own error for the same reason.
- **Viewers lease the pane; a lease is never expired on a timer.** `open` takes one and
  `close` returns it, so two viewers — two windows, or two paired clients on a host — do not
  cancel each other's fold. A viewer that dies without closing (a torn-down window, a dropped
  paired client) leaves a lease behind, which costs memory and one fold that runs to
  completion with no reader. It cannot cost correctness: the seen cursor is recorded on
  every close, whoever else still holds the pane, and never moves backwards.
- **An SSH read is capped, never truncated.** Over 24 MB the fold fails with a message
  rather than parsing a shortened file: dropped head events would renumber every entry the
  ledger's cursor counts. Only a hook-reported path is used, because on that host there is
  no root search and no synthesizable Copilot session directory.

### States the pane can be in

| Status | Meaning |
| --- | --- |
| `folding` | a fold is in flight here or on the host |
| `ready` | a ledger exists and is on screen |
| `unavailable` | no readable transcript, or a readable one with no messages yet |
| `failed` | the fold, the transcript read, or the host call failed; `error` says which |
| `unsupported-host` | a host id this build cannot place, so nothing is read or folded |

A failed refresh over an existing brief still shows that brief: the header reads
"Couldn't refresh — showing the last summary" unless a real backlog is waiting, and the body
says it above the ledger. A poll of a host fold that fails is retried once first, so a relay
blip does not freeze a stale brief.

A ledger that no fold ever produced is never written (`hasProducedLedger`). `close()` used to
record one anyway, which made the next visit read a non-null ledger as **"Up to date" over a
blank body** — the empty state that should mean "here is the brief" (fork issue #135). For
the same reason a readable transcript with no new events is `ready`, not `unavailable`: it
is not a session that has no transcript.

## Adding a right-sidebar tab

`summary` is a **static** tab, so a new value has to be declared in three allowlists or it
silently disappears:

- `src/shared/ui-chrome-types.ts` — the `RightSidebarTab` union;
- `src/shared/rpc-contract/client-ui-params.ts` — `STATIC_RIGHT_SIDEBAR_TABS`, which a
  type-only parity assertion compares against the union;
- `src/main/persistence/applying-settings/ui-selection-normalization.ts` — the persisted-value
  allowlist, without which the tab resets to Explorer on restart.

Across versions this is safe in both directions: `tolerateUnknownValues` drops a value an
older host cannot express instead of failing the whole `ui.set` batch, and an older client
normalizes an unknown tab to Explorer.
