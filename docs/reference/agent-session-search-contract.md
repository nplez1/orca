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

A cursor belongs to one query and one host's index generation. Query, scope,
filters, and sorting must remain the same; page size may change. Writes that
advance the generation can invalidate it, including retention purges. A refused
cursor yields `{ kind: 'stale-cursor', generation, expectedGeneration? }` and the
client discards it and issues page 1 without a cursor. Reusing that refused cursor
continues to fail; there is no server-side cursor acknowledgement state.
Malformed cursors and cursors for a different query yield
`{ kind: 'malformed-cursor' }`. Generation checks also reject a first page if the
index changes during retrieval. Generation is a fence, not a retained snapshot:
a client cannot ask the host to recreate a previous generation.

Pages are per host only. Ordering is local to that host's query. Clients must
discard cursors when changing hosts.

## All-hosts search

`all` as the execution host scope merges every reachable host: this desktop's own
index, every active SSH relay, and every paired runtime with a transport. The
desktop requests one page from each with bounded parallelism and a per-host
deadline, so one host cannot hold the page open. A host that fails, times out, or
has no service becomes a per-host status entry, never a silent omission. This is
one process's merge; a host that cannot merge still refuses `all`.

- **Fusion.** BM25 scores are per-corpus and not comparable across hosts, so only
  ranks cross that boundary: `score(d) = Σ_hosts 1/(k + rank_host(d))`, `k = 60`,
  tie-broken by `(score DESC, updatedAt DESC, executionHostId, sessionId)`. A merged
  hit's `score` is that sum, comparable only within one merged response.
- **Bounded merged depth.** Every host is asked for `SESSION_SEARCH_LIMIT_MAX` (100)
  rows — the ceiling the request schema clamps to, silently — so a merged search is
  a top-K over at most 100 ranked rows per host. A `limit` the caller asked for
  above that ceiling, a host whose page was full, or a host whose retrieval hit its
  own cap sets `truncated.candidates`. Deeper results are a single-host operation.
  No merged request forwards a cursor to a host, so paging cannot raise the ceiling.
- **Truncation.** `candidates` and `query` are true when any contributing host
  reported them; `freshness` is true when a host reconciled past its window, a probe
  found a moved or unverifiable generation, or a recorded host could not be
  re-observed. `snippets` counts truncated snippets across the rows the merge
  fetched, not only those on the returned page, because `snippetTruncated` is an
  engine field the host does not put on the wire.
- **Frozen order, not re-fusion.** Generation advances on every index write, so it
  cannot fence rank stability. Page 1 fuses and the desktop freezes that sequence;
  later pages slice it and re-observe each recorded host with `searchStatus`, which
  is cheap and carries the generation. A moved or unverifiable generation keeps the
  frozen order and sets `truncated.freshness`; new and changed rows appear on the
  next page-1 refresh. **An in-flight pagination is a snapshot, not a live view.**
- **Cursors.** A merged cursor is opaque and belongs to one query and one frozen
  order; page size may change between pages. It is process state in the desktop,
  bounded (8 orders, 10-minute TTL). An evicted order or a changed query yields
  `stale-cursor` with the highest recorded generation; a cursor this desktop did not
  mint yields `malformed-cursor`. Both mean: discard it and issue page 1.
- **Duplicates.** Fused rows are deduped on `(agent, sessionId, cwd)` — never on
  `filePath`, which relay transports withhold — preferring the leg whose source
  presence is `present`, then `local`. Every leg still contributes its rank to the
  surviving row's score. A native-Windows and a WSL view of one transcript spell
  `cwd` differently and stay two rows; that limitation is known and not silent.
  Dedupe can underfill a page, which `truncated` reports rather than hiding.
- **Attribution.** Every merged hit carries the `executionHostId` of the host the
  surviving row came from, stamped by the desktop that addressed the host.
- **Per-host outcomes.** A merged results response carries `hosts` (additive,
  optional): one entry per attempted host with `outcome` `contributed`,
  `unavailable`, or `error`, plus a fixed `reason` (`no-service`, `disabled`,
  `not-ready`, `timeout`, `failed`, `malformed`). Loss of contact is `unavailable`,
  never a dead/exited verdict, and no transport message crosses. `generation` is the
  highest generation observed, not a fence; the per-host generations are in the
  cursor. The merged path does not answer `debug`. A host enumerator that throws
  contributes one entry labelled with the surface it was listing (`ssh` or
  `runtime`) rather than dropping the hosts it would have listed.
- **No host answered.** The merged answer is
  `{ kind: 'unavailable', reason: 'disabled' | 'not-ready' | 'no-service' }`, never
  an empty success. `no-service` also covers "nothing answered at all".
- **Per-host query ladders.** Each host repairs a phrase/AND/typo/OR query on its
  own ladder, so two hosts can repair one query differently. Accepted for now.

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

The process-local `setSessionSearchService(service | null)` registry is the only
production seam in this PR. Tests use fake services and a real synthetic store.
Nothing constructs an engine or indexer in production. PR 3b owns process
lifecycle, consent/settings application, and registration of the production service.
