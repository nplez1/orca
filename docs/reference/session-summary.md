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

- **Lazy by construction.** Opening the pane starts the fold; closing it cancels in-flight
  work. Nothing runs for sessions nobody opens, so there is no background LLM spend.
- **Cheap facts are always available.** State, timestamps and event counts come from the
  status entry, so the header hint ("Up to date" / "N events to catch up on") needs no fold.
- **Bounded, resumable chunks.** The transcript is split deterministically into slices of at
  most 24k chars or 40 events (`session-summary-fold.ts`), extracted in parallel and merged
  deterministically. Completed extracts are cached, so a fold that is cancelled or fails
  resumes instead of restarting.
- **Atomic.** A failed or unparseable chunk keeps the last good ledger and retries next time.
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
