# Session summary

A **session summary** is a written brief about one agent session: what it is trying to do,
what it has finished, what it is doing right now, what blocks it, and a timeline of
highlights whose entries point back at the transcript message they came from. It exists
so a user returning to a long-running agent does not have to re-read the terminal.

## Where it is surfaced

| Surface                                                           | File                                                               | Reachable          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| Right-sidebar **Summary** tab (`RightSidebarTab` value `summary`) | `src/renderer/src/components/right-sidebar/SessionSummaryPane.tsx` | yes                |
| Collapsed strip in the Activity thread detail pane                | `src/renderer/src/components/activity/session-summary-panel.tsx`   | **no** — see below |

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

- **Native-chat agents** (Claude/OpenClaude, Codex, Grok, OMP, OpenCode/ZCode) go through
  `native-chat/session-file-resolver.ts`, which takes the hook's `transcript_path` when it is
  host-readable and otherwise searches the agent's own roots by session id.
- **Pi and Prime Agent** post `session_file` on every hook, so the reported path _is_ the
  transcript; `agent-session-resume.ts` only returns their provider session at all when that
  path exists.
- **Copilot** reports no path, but its `session_id` is the name of its session directory:
  `$COPILOT_HOME/session-state/<id>/events.jsonl`.
- **Every other agent** is read from the path its own hook reported, with the AI Vault parser
  for that agent. There is no allowlist to add an entry to: `resolveHookPathParser` accepts any
  agent `AI_VAULT_AGENTS` can decode, because the parsers are already agent-generic
  (`parseAgentSessionFile` dispatches on `candidate.agent`).

What that widening does **not** do is give every agent a transcript. An agent is only readable
when a path can be found for it, and the agents whose hooks report only an id — Gemini, Cursor,
Droid, Kimi, Kiro, ZCode, DSH, Antigravity, OpenCode 2, Devin, JCode, Hermes — have no root
search here, so they still resolve nothing and the pane says so. Agents whose hooks report a
path (Claude, Codex, Qoder, CodeBuddy, Qwen, Muse, Pi, Prime Agent, OMP) and Copilot (whose
session id names its directory) are the ones that fold today. Closing that gap means a
session-id search over each agent's own roots — the same idea as
`native-chat/session-file-resolver.ts` — and is not implemented.

- **The viewer's identity travels with the request.** `open` carries the session the viewer
  has on screen (`SessionSummarySessionRef`: agent type and provider session), taken from the
  pane's records in the _viewer's_ store — the live row, then the parked sleeping record, then
  the retained entry, because an idle Pi session is identity-only and keeps no live row
  (`resolveSessionSummarySessionRef`). The identity is the half a fold cannot do without, and
  the process that folds is not always the process holding the row: a paired host runs the PTY
  while the client owns the layout, and a client clears its rows on reconnect. Both then read
  no identity and reported "no readable transcript" for a session that was running the whole
  time. `mergeSessionRef` lets this process's own row win wherever it names a session (its own
  latest evidence, and folding a lagging client id would brief the previous conversation —
  #135), takes the agent type from whichever side supplied the session, and fills a missing
  transcript path from the request. An older caller sending nothing keeps the previous
  behaviour, and an older _host_ ignores the field, so a paired host must run this build for
  its panes to benefit.
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
- **Two written reports, not one accumulated one.** After the chunk extracts, one more call
  rewrites both prose reports from (previous reports + this batch): `reportSince` (what changed
  since the reader last spoke to the agent) and `reportFull` (a whole-session progress report).
  Accumulating prose is what turned the brief into a play-by-play; rewriting keeps the full
  report short however long the session gets, and because its input is the previous report plus
  one batch, it stays a few hundred tokens. A failed rewrite keeps the previous reports and does
  not fail the fold — the facts and timeline already landed.
- **Every fact carries the message it came from.** `SessionSummaryFact` is `{ text, sourceIndex }`
  for `goal`, `inProgress`, `plan`, `done`, `blockers` and `decisions`; a fact the extract did not
  index — or indexed outside its own slice — is placed at the slice's _last_ message. That index is
  the only thing needed to draw the window below, so both views cost neither a second fold nor a
  second read.
- **Unindexed facts belong to the slice's last message, and indexes outside the slice are
  rejected.** A model that answers with a slice-relative index (`0` for the first message it saw)
  would otherwise put a whole slice before the reader's last message and hide it from the window;
  the slice's last message is the conservative placement, because a slice usually opens with the
  reader's own message.
- **A `goal` is replaced, never unset.** A later chunk that says nothing about it leaves the
  title alone — the reader asked for a top-line title, and one silent chunk used to erase it.
- **The window is the reader's last message, not the last time they looked.** The fold records
  `lastUserMessageIndex` (and `userMessageCount`) from the transcript's own `user` events. The
  pane shows, by default, what happened _after_ that message. The old behaviour moved a cursor
  when the pane closed, which measured looking rather than interacting: a pane left open all day
  reported a day of work as already read. `seenThrough` is still recorded and sent by the close
  RPC for older peers, but no view reads it.
- **Atomic.** A failed or unparseable chunk keeps the last good ledger and retries next time.
  Completed chunk extracts are kept for that retry only once a fold has produced a ledger —
  an unproduced one is never stored, so a first fold's chunks are lost with it.
- **The pane opens as a brief, not a log.** The title is the whole-session goal, then the written
  report, then the ledger (facts) and the timeline — both collapsed by default, and an empty one
  drops out rather than showing a row
  (`components/activity/session-summary-ledger-view.tsx`). One switch — _Show the full session_ —
  swaps the whole-session report and every fact in; it is a re-render, not a fold. When the reader
  has spoken to the agent only once, the window _is_ the session: the fold then writes one report
  (`since: null`) and the pane offers no switch between two identical halves.

### When it folds

The fold spends a model call, so it runs on signals, not on every chunk the agent produces:

| Trigger                                                   | Rule                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Opening the pane (first time, or a session with no brief) | folds                                                                                                                 |
| Coming back to the tab                                    | folds only when the brief is older than **5 minutes** _and_ the agent's row has moved since it (`revalidateWithinMs`) |
| Pane visible while the agent works                        | at most **once an hour**, and only when the row was updated after the last fold                                       |
| The refresh button                                        | always folds (a fold with no new events never reaches the model, so it is cheap)                                      |

A pane nobody is looking at never folds; the hourly timer exists only while the pane is open.

Two details that are easy to get wrong, and are load-bearing:

- **A refresh is the same viewer.** `open` takes the pane's lease, so a refresh or an auto-fold
  sends `sameViewer` and takes none: one lease per _viewer_, one close per unmount. A lease per
  request would outlive that close and cancel-on-close would stop working after the first click.
- **A paired host runs the same freshness rule.** The window travels with `openOnHost` because
  the brief being reused lives in the host's own cache; only the host can age it. A relayed
  ledger is also coerced on arrival (`session-summary-relayed-ledger.ts`), because a host on an
  older build relays facts as bare strings and no boundary — read as-is, that hides every fact.
  The reverse (a _new_ host relaying to an older desktop) is not repairable from this side, so a
  paired pair should update together.

The ledger cache is `session-summaries.json` under `userData`, written atomically. It is a
rebuildable cache: deleting it costs one fold per session, never state. Its `version` covers the
_shape_ of a ledger, so a shape change (facts gaining `sourceIndex`, reports arriving) discards
every entry rather than carrying a migration forever.

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
- **A cached list is refreshable.** The pane offers _Refresh models_, which drops the cached
  probe for the selected agent and lists again; without it, a model the CLI started
  reporting would stay unreachable for the life of the install.
- **Storage is host-keyed; resolution is local.** The pane's model list describes the agent
  CLIs this window can spawn, and it is stored under the host-keyed slots so a host-aware
  resolver needs no migration. It still reads the local slot: a fold the desktop runs uses a
  local CLI, and a fold a paired host runs uses a CLI installed _there_, with the agent and
  model named by the request (see "Which host folds").

## Which host folds

The fold runs wherever the session's transcript lives, so accessing a session remotely
behaves like working on that machine directly.

| Workspace host  | Transcript read                                                      | Fold (agent CLI)    | Ledger, chunk cache, seen cursor           |
| --------------- | -------------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| `local`         | local filesystem                                                     | this window         | local `session-summaries.json`             |
| `ssh:<target>`  | `cat` over the SSH connection Orca already holds, streamed to a copy | this window         | local `session-summaries.json`             |
| `runtime:<env>` | the paired host's own filesystem                                     | **the paired host** | the paired host's `session-summaries.json` |

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
  error rather than substituting one. The same open also carries the pane's session identity
  (see “The viewer's identity travels with the request”), so a host whose own row for that
  pane is missing or path-less folds the session the client is actually showing.
- **The host trusts the path the request names.** Where a host has no row of its own for the
  pane, it folds the transcript path the client sent, exactly as it would fold its own hook's
  path — the same trust level as a terminal it was asked to run, and the same file the client
  could already read. The alternative, refusing any path the request names, is what made a host
  with no row report nothing at all. The path is normalized like any relayed metadata
  (`normalizeAgentProviderSession` rejects control characters).
- **A pane key that does not match a host row is not fatal any more.** Both lookups still
  compare `paneKey` exactly, while the hook server re-keys rows through `resolvePaneKeyAlias`;
  an aliased key therefore misses the host's row. With the request identity that miss now costs
  nothing — the fold proceeds on the identity the client sent instead of reporting that it
  cannot read a transcript it was never asked to find.
- **A paired host that predates these methods** answers `method_not_found`, which the pane
  reports as "Update Orca there to summarize its sessions" — a remedy, not a failed fold.
  Older servers are the normal case, since they update on their own schedule.
- **A request without a usable agent is rejected, not defaulted.** The host folds with the
  agent and model the request names; when it cannot parse them it fails the open rather than
  substituting its own settings, because a summary is the user's own transcript. A host that
  lacks that CLI fails the fold with its own error for the same reason.
- **Viewers lease the pane, and a lease is never expired on a timer.** `open` takes one and
  `close` returns it, so two viewers — two windows, or two paired clients on a host — do not
  cancel each other's fold. For a paired host the lease count lives with the client-side
  subscription, because an open answers asynchronously: a close that arrives before the host
  answered waits behind that open instead of being dropped (its lease would live on) or sent
  early (it could take another client's). A viewer that dies without closing (a torn-down
  window, a dropped paired client) leaves a lease behind, which costs memory and one fold
  that runs to completion with no reader. A viewer whose open _failed_ owes the host nothing,
  so its close is spent against that failure rather than against the next lease in line — a
  close that took another viewer's lease would end their fold early. An absorbed close hands
  its place forward: the highest count it reported rides along with the next close this pane
  sends to that host, and the cursor never moves backwards. A place with no later close to
  ride on — or one whose open failed with nobody else reading — is dropped, and a pane
  that goes fully idle drops it too rather than reporting it against whatever session takes
  the pane next. One caveat: after a host restarts, a close from a client that still believes it
  holds a lease is charged to another viewer's lease there, which can end that viewer's fold
  early.
- **An SSH read is capped, never truncated.** Over 24 MB the fold fails with a message
  rather than parsing a shortened file: dropped head events would renumber every entry the
  ledger's cursor counts. Only a hook-reported path is used, because on that host there is
  no root search and no synthesizable Copilot session directory.

### States the pane can be in

| Status             | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `folding`          | a fold is in flight here or on the host                                    |
| `ready`            | a ledger exists and is on screen                                           |
| `unavailable`      | no readable transcript, or a readable one with no messages yet             |
| `failed`           | the fold, the transcript read, or the host call failed; `error` says which |
| `unsupported-host` | a host id this build cannot place, so nothing is read or folded            |

An `unavailable` snapshot carries an `error` naming which cause applies — nothing written yet, a
transcript this fold could not reach where its host reported it, or an agent whose transcript
format this build cannot decode at all (`canReadAgentTranscript`). One message for all three left
the reader no way to tell a fresh session from a misreported one.

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
