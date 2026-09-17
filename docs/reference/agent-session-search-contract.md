# Agent session search contract

`AiVaultSearchRequest`, `AiVaultSearchResponse`, `AiVaultSearchHit`,
`AiVaultSearchHostStatus`, and `AiVaultSearchStatus` are defined in
`src/shared/ai-vault-search-types.ts` and validated by
`src/shared/ai-vault-search-contract.ts`.

## Tiers and consent

One database holds two tiers, and only one of them needs consent.

- **Metadata** — one `sessions` row per transcript (agent, session id, path, cwd,
  branch, model, times, counts, title, resume command) plus `sessions_fts` over
  titles, working directories, branches and agent names. Always indexed: it is what
  Agent Session History lists, and every one of those values is already shown in the
  panel.
- **Content** — message bodies in `messages` and `messages_fts`. Opt-in: this is
  the tier that reads every transcript on the machine end to end.

`AiVaultSearchSettings` is `{ contentEnabled, historyDays }`. The pre-tier field
name `enabled` named the same consent `contentEnabled` names, so a profile that
recorded it keeps it rather than having the question silently re-opened. Retention
applies to both tiers.

With content off the host stores no message rows at all, so a text query is
answered from `sessions_fts` — title, path, branch and agent matches, ranked by
bm25 with `updated_at`/`id` as a total tiebreak. Those hits carry `evidence: null`:
there is no transcript text to quote and none is fabricated. `status.contentEnabled`
reports the tier; `status.enabled` means only that an index exists and runs, which
is why `disabled` is no longer an answer a host with `node:sqlite` can give.
Consent is per host: a paired client's search is answered under the consent recorded
on the host that owns the index.

## Search and pagination

- Tool output beyond 3,072 characters per row is not indexed and not searchable; user and assistant text is indexed in full.
- A page cursor outstanding during a retention purge is refused once as `stale-cursor`; the client re-issues page 1.
- A phrase match across a chunk boundary of a long message is not supported.

`aiVault.searchSessions(request)` accepts `query`, optional `scope`
(`conversation` or `all`, default `all`), `freshness` (`indexed` or
`wait-until-current`, default `indexed`), `limit`, opaque `cursor`, `filters`,
and `debug` (default false). Conversation scope searches user and assistant text.
Filters accept `agents`, `scopePaths`, ISO `since`, and `sort` (`relevance` or
`newest`). Paths refer to the execution host and work for folders without Git.
Legacy `tier` and `refresh` fields are accepted and discarded; they do not change
the defaults. Limits use the engine's resolver: default 20, integers clamped to
1–100, fractional numbers use the default. Long queries reach the engine so it
can report truncation rather than fail validation.

Results contain `kind: 'results'`, `hits`, `page: { cursor, hasMore }`,
`generation`, `truncated: { candidates, snippets, query, freshness }`, and
`durationMs`, plus `hosts` on a merged answer only.
`snippets` is a count; the other truncation fields are booleans.
`durationMs` measures the engine search, excluding any reconciliation wait.
`debug: true` adds `debug: { route, repairedTerms?, plannerReport }`; the report
contains `route`, optional `repairedTerms`, and `scope`. Diagnostics never appear
at the top level. Status is never attached to search results.

A cursor belongs to one query, one host's index generation, and an opaque persisted
index incarnation. Query, scope, filters, and sorting must remain the same; page
size may change. Writes that advance the generation can invalidate it, including
retention purges. Clearing or rebuilding the database invalidates it even when the
new generation counter matches. A refused cursor yields
`{ kind: 'stale-cursor', generation, expectedGeneration? }` and the
client discards it and issues page 1 without a cursor. Reusing that refused cursor
continues to fail; there is no server-side cursor acknowledgement state.
Malformed cursors and cursors for a different query yield
`{ kind: 'malformed-cursor' }`. Generation checks also reject a first page if the
index changes during retrieval. Generation is a fence, not a retained snapshot:
a client cannot ask the host to recreate a previous generation.

Pages are per host only. Ordering is local to that host's query. Clients must
discard cursors when changing hosts.

## All-hosts search

`all` as the execution host scope fans one query out to every execution host — this
desktop's own index, every active SSH relay, and every paired runtime with a
transport — and merges their pages into a single answer. The engine is upstream's;
this fork carries no merge of its own.

- **Two orders, not fused scores.** Relevance scores come from independent indexes
  and are not comparable across hosts, so only two orderings cross that boundary:
  recency, which every host can be asked for directly, and round-robin over each
  host's own ranking.
- **Page-by-page legs.** Every host is walked page by page — at most
  `MAX_HOST_PAGES_PER_REQUEST` (3) pages per host per merged request — so a hit that
  lost the cut on one page is emitted on the next instead of being dropped, and a
  host that still owes hits keeps its entry in the walk.
- **Merged cursor.** The merged cursor is opaque and belongs to one query and one
  sort. It records each host's own cursor for that request (per host `{ c, e, g }`),
  so paging resumes inside every leg rather than re-asking each host for page one.
- **Per-host outcomes.** A merged results response carries `hosts` (additive,
  optional): one entry per attempted host with `outcome` `searched`, `stale`,
  `disabled`, `not-ready`, `no-service`, or `unreachable`. A host that cannot
  answer is an entry, never a silent omission, and loss of contact is never a
  dead/exited verdict — no transport message crosses to the client. See
  `docs/reference/ssh-execution-boundary.md`.

## Execution host routing

Search and status address one execution host: `local`, `ssh:<target>`, or
`runtime:<environmentId>`, plus `all` on the desktop IPC surface. An omitted host
means this desktop's local index. Invalid IDs are refused and never widen a
request to other hosts.

- `local` searches this machine's index over desktop IPC.
- `ssh:<target>` asks that relay session and nothing else.
- `runtime:<environmentId>` asks that paired runtime over its RPC. A paired
  runtime answers for itself and never forwards through another desktop.
- `all` merges this desktop, every active SSH relay, and every paired runtime
  with a transport; see [All-hosts search](#all-hosts-search).

Each hit may carry `executionHostId`. The desktop stamps remote answers with
the host it addressed rather than trusting an ID returned by that host.
Local answers and older hosts may omit attribution.

## Evidence and exposure

Each hit carries agent, session ID, title, cwd, branch, updated time, message
count, score, source, and evidence. Evidence contains snippet, role, and timestamp;
it is null for operator-only matches that have no text evidence. Snippet matches
use `[[` and `]]` markers. Source presence is `present`, `unverifiable`, or
`missing`; the current engine emits the first two. Loss of contact does not prove
a source missing.

`redactForTransport(hit, transport)` is the exposure policy:

| Transport                                 | filePath / codexHome                 | resumeCommand                     | Status `degradedRoots[].root` |
| ----------------------------------------- | ------------------------------------ | --------------------------------- | ----------------------------- |
| Desktop IPC on the same machine           | Included when known, under source    | Included only for present sources | Included                      |
| Runtime RPC on the same machine           | Included when known, under source    | Included only for present sources | Included                      |
| Relay or paired runtime/web/mobile client | Withheld; source keeps presence only | Withheld                          | Withheld                      |

`cwd`, titles, snippets, and other hit metadata remain visible to paired clients.
Snippets cross the authenticated transport as indexed; this contract does not
apply an observability redactor to transcript content. A missing Codex home is
omitted. Resume commands reuse the command stored by the transcript reader,
constructed by the sidebar's `buildAiVaultResumeCommand`; this layer does not
construct commands or execute them. The runtime uses its authenticated
`clientKind` context to distinguish paired clients from same-machine RPC, never
a request-supplied locality flag. The receiving remote client also applies the
same exposure function. Each leg of an all-hosts merge is fetched through the
client for its own transport, so a relay-borne hit is redacted at the host it
came from and a local hit keeps its paths.

## Status, freshness, and availability

`aiVault.searchStatus()` returns `enabled`, `phase` (`idle`, `indexing`, `current`,
`degraded`, or `closed`), `filesIndexed`, `filesDue`, `filesFailed`, `degradedRoots`
(`root` and `reason`), `lastReconcileAt`, `lastSweepCompletedAt`, and `generation`.
Times are milliseconds since epoch or null. These are the indexer's observations;
an indexed row is not a new filesystem verification. A degraded root's `root` and
raw `reason` can both contain host filesystem paths. Desktop IPC and same-machine runtime RPC receive the full diagnostic;
relay and paired clients receive only the fixed reason "Source root could not
be verified." for each degraded root. The array length retains the count.

`wait-until-current` calls `service.reconcile()` before searching. The adapter
uses `indexer.reconcile({ full: false })`. After five seconds the endpoint searches
anyway and sets `truncated.freshness: true` on results. It does not cancel the
host's reconciliation. Completion before the deadline leaves the flag false;
a reconciliation error before the deadline propagates. The indexer's bounded
recent pass is not a promise that the entire historical corpus was swept. A merged
page forwards the request to every host, gives each leg a bound longer than that
window, and sets `truncated.freshness` if any host or frozen snapshot reports it.

`aiVault.searchStatus` with `all` reports one summary over the hosts that answered,
not a per-host report: `enabled` is true if any host is enabled, `contentEnabled`
is present only when every answering host reports it and they agree, `phase` is
`degraded` if any host is degraded, else `indexing` if any is, else `closed` if all
are, else `current` if all are, else `idle`, counts are sums, `degradedRoots` is the
concatenation in host order (already redacted per transport), timestamps are the
newest non-null observation, and `generation` is the highest. No host answering
yields the absent-service sentinel. Hosts that did not answer contribute nothing
and are not named here; a merged search response's `hosts` is where per-host
outcomes are reported.

Search unavailability is a value:
`{ kind: 'unavailable', reason: 'disabled' | 'not-ready' | 'no-service' }`.
No registered service returns `no-service`. Status without a service has
`enabled: false`, `phase: 'idle'`, zero counts and generation, empty degraded roots,
and null timestamps. This is a sentinel for an absent service, not a claim of an
empty, current index. A registered service may report disabled or not-ready.

## Boundaries and compatibility

- Desktop: `aiVault:searchSessions` and `aiVault:searchStatus`, via preload.
- Runtime and relay: `aiVault.searchSessions` and `aiVault.searchStatus`.
- CLI: `orca search` calls both over the runtime RPC, against the host that
  `--environment` / `--pairing-code` selects and no other. It reuses
  `createSessionSearchClient`, so an old host's refusal reaches the caller as
  `unavailable/no-service` rather than an error, and needs no new capability.
  In an Orca SSH terminal, the forwarded CLI defaults to the controlling Orca
  runtime's index. `--path` filters that index; it does not select the SSH host.
  `--environment` / `--pairing-code` can explicitly select a paired runtime.
- Desktop preload optionally accepts an execution host scope as a separate
  routing argument, including `all`. A named host is addressed exactly; missing
  connections never fall back to the local index. The web preload addresses its own
  paired runtime, answers `all` and any other host with
  `unavailable/no-service` rather than an error.

Requests and responses are parsed where received from another process. Existing
relay JSON-RPC request/response framing needs no new stream opcode. Following the
existing relay method probe pattern, an old host's explicit `-32601` refusal (or
runtime `method_not_found`) maps to `unavailable/no-service` on the client; status
uses the absent-service sentinel above. Transport failures, authentication errors,
and invalid payloads remain errors. Unknown request fields are stripped for wire
compatibility.

The process-local `setSessionSearchService(service | null)` registry connects
these endpoints to the production service installed by PR 3b. Desktop indexing
runs in the scanner child; orcad and the SSH relay register their own in-process
services. Registration alone does not grant consent.

## Desktop index controls (PR8)

Settings → Agent Session History controls this desktop's persisted
`aiVaultSearch { enabled, historyDays }` policy. It stays local even when another
execution host is selected. Paired clients cannot grant consent or clear an index
through this surface; SSH relay registration remains disabled without a separate
host consent mechanism.

`aiVault.clearSearchIndex()` is a no-argument desktop-only preload operation over
`aiVault:clearSearchIndex`. It addresses the local scanner child, not the selected
remote host. The child's existing interactive request lane executes `searchClear`
through `SessionSearchInstance.clear()`: close the indexer and database handles,
remove the SQLite database and sidecars, then reconstruct only if consent remains
enabled. Errors propagate to the settings pane. This operation never deletes
original transcripts. There is no new runtime or relay method. Opaque cursors also
carry a persistent database identity: clearing creates a new identity, so a
pre-clear or legacy cursor returns `stale-cursor` even if the rebuilt numeric
generation happens to match. Reopening the same database preserves its identity.

Disabling closes the indexer and keeps the index copy; clearing deletes the copy.
Changing retention reuses the existing close-and-construct policy application.
The settings pane reads status only while enabled and visible, polls only an
observed indexing phase, and stops on completion or error. Opening the pane,
changing policy, or pressing Refresh obtains a new observation. The indexer's own
schedule does not depend on the pane.
