# File-path filtering at scale

The Explore pane's name filter and Quick Open (Cmd+P) both search a workspace's file
paths. Both are bounded by `QUICK_OPEN_LISTING_MAX_RESULTS` (20 001) today, in a way that
can report "No files match this filter" for a file that exists. This page is the contract
for how path search behaves on large workspaces and across host versions.

## The defect

Two independent failures produced silently empty results on a large repository:

1. The Explore name filter gated its projection on `resolvedQuery === query`. A local
   listing is unscoped, so `resolvedQuery` is `undefined` and every local query resolved
   to `[]`. (Fixed; see "Already landed".)
2. **Filtered search used a truncated full listing.** Locally, filtering ran off
   `listQuickOpenFiles(..., maxResults: QUICK_OPEN_LISTING_MAX_RESULTS)`, which stops the
   ripgrep walk at 20 001 paths **in ripgrep's unsorted traversal order**
   (`src/main/ipc/filesystem-list-files.ts`). Whether any given file is inside that prefix
   is arbitrary, and the Explore pane never rendered the `truncated` flag, so a file past
   the prefix read as "no files match". Quick Open renders "(results truncated)"; the
   filter did not.

## The contract

A filter must never claim more than it knows.

- The **search scans and counts everything**; only the **display retains a bounded page**.
  Dropping is a rendering bound reported to the user, never a search bound implied to be
  complete.
- "No files match" may be shown **only** when the host scanned the whole workspace and
  returned zero matches. A truncated listing renders a partial-scan message instead.
- A user reaches a match outside the retained page by **narrowing the query** — not by
  paging. Paging over a mutating filesystem needs snapshot tokens and host-side caches,
  which is the memory this design exists to avoid.

"A filter must not drop results" is not implementable literally: a one-character query can
match 300 000 paths. The contract above is the implementable form.

## Design

Matching belongs to the **execution host** — the main process locally, the relay over SSH,
the runtime environment over RPC. That is already true for SSH (`fs:listFiles` forwards
`searchQuery`) and runtime environments (`files.searchPaths`); the gap is local-only:
`fs:listFiles`'s local branch ignores `args.searchQuery`, and the renderer's
`searchRuntimeFilePaths` returns `{ files: [], truncated: false }` when there is no
`connectionId`.

One mechanism, two matchers:

| Pane | Matcher | Semantics | Retention |
| --- | --- | --- | --- |
| Quick Open | `QuickOpenPathRanker` (`src/shared/quick-open-path-search.ts`) | fuzzy subsequence over the path, scored | top ~50 |
| Explore name filter | name-filter matcher (substring-AND on the lowercased relative path, the semantics of `relativePathMatchesNameFilter`) | strict substring tokens | sorted page, ~5 000 |

Do **not** point the Explore filter at the fuzzy ranker: substring-AND is the pane's
documented behavior, and it needs a sorted page for the tree, not a score heap.

The host scan is what `searchQuickOpenFilePaths` (`src/main/ipc/filesystem-search-file-paths.ts`)
already implements: one ripgrep pass, lines streamed through the 64 KB-bounded
`QuickOpenSubprocessPathAccumulator`, a per-line matcher that **counts every match** and
retains only the bounded page. Note that its single `--no-ignore-vcs` pass is a deliberate
superset of the full listing's `primary` + `ignoredPass` pair, not an oversight.

Delivery is request/response with the existing `requestToken` + `AbortSignal` cancellation;
a superseded keystroke kills the prior scan host- and relay-side. Results are sorted with
`compareFileNames` so the page is stable.

Memory is bounded independently of repository size: rg's stdout buffer, the retained page
(via `createQuickOpenListingBudget` / `retainQuickOpenPath` in
`src/shared/quick-open-listing-limits.ts`), one integer match count, and the renderer's
synthetic tree over the retained page. At the retention bound the host **degrades** —
returns the sorted page, the exact total, and `truncated: true` — it does not fail.

### Warm path inventory (local)

A name filter only needs file names, so the walk — not the match — is the entire cost, and
paying it per keystroke is what made the pane slower than the Contents tab. The main process
keeps a per-root path inventory (`src/main/ipc/quick-open-path-inventory.ts`): `included` (the
Contents-tab scope, gitignore-aware) and `all` (the `--no-ignore-vcs` superset a pane showing
gitignored files needs). It is warmed off the interactive path when the pane loads its
unscoped listing, and answers `fs:searchFilePaths` name-filter queries from memory.

The scan scope must match the display scope: `showGitIgnoredFiles: false` searches `included`
(the same set the Contents tab scans), `true` searches `all`. There is no third, always-
superset scope — that is what made a name filter walk a much larger tree than a content search.

Freshness is honest by construction: the local watcher drops the entry when the path set
changes and a debounced build re-warms it, a TTL covers events the host never sees, and a query
that finds the entry stale or rebuilding returns "not warmed" so the caller scans live. A
missing or over-budget entry is **never** reported as "no matches". The budget is separate from
`QUICK_OPEN_LISTING_MAX_RESULTS` (a listing OOM bound): crossing it drops the cache with a log
line and degrades to the live scan, rather than truncating.

Because the inventory already knows which paths git ignores, the host returns that subset on
the matched page and the pane skips its own per-keystroke `git check-ignore` (measured ~0.9s
over 5 000 paths) for the filtered view.

### What happens to the 20 001 bound

It stays. It is an OOM bound from the memory-hardening work (#10179 / #10299), aliased by
`QUICK_OPEN_READDIR_MAX_FILES` (the readdir fallback throws past it), clamped by the relay
via `resolveQuickOpenResultLimit`, and used by the runtime file command path. Raising it
also re-introduces the renderer cost that motivated scoped search: fuzzy-ranking the whole
retained array per keystroke.

It applies to **unscoped** listings only — browse mode, an empty Quick Open query, legacy
host inventories, the readdir fallback. A filtered query takes the scoped path with its own
smaller cap, which is how a user escapes the ceiling.

### Wire compatibility

Per [`remote-wire-compatibility.md`](./remote-wire-compatibility.md):

- **Local IPC** is same-version on both sides; a structured return
  (`{ files, totalCount, truncated }`) is fine.
- **Runtime RPC**: `files.searchPaths` already carries `mode: 'quick-open'` and a
  `quickOpenSearchVersion` field. A new `mode: 'name-filter'` is a new optional field
  (Rule 1). An old host ignores `mode`, returns quick-open results with a version below the
  new one, and the client falls back to the existing `searchLegacyQuickOpenInventory`
  chain, surfacing the existing "update your host" message at the end of that chain.
- **SSH/relay**: `fs-handler-list-files.ts` is already `searchQuery`-aware; the matcher mode
  is added the same way, with the same capability fallback. **No new stream opcode**, so
  Rule 2 does not apply.
- An old host keeps serving the 20 001-bounded inventory; the client must render the
  partial-scan message for it rather than a false empty.

## Staging

1. **Local, both panes — LANDED.** `fs:searchFilePaths` serves a local query-scoped search
   (`searchQuickOpenFilePaths` with a matcher mode) as
   `{ files, totalCount, truncated }`; `searchRuntimeFilePaths` uses it for a local workspace;
   `useRuntimeFileListForWorktree` takes the scoped path for a local workspace once the query
   is non-empty (browse mode with an empty query keeps the unscoped listing, so Quick Open
   still shows files before you type) and carries `totalCount` to both panes; the Explore pane
   shows a partial-result notice. Runtime environments and legacy inventories also report
   `totalCount`, which their replies already carried.
2. **Remote hosts, exact name-filter totals.** `mode: 'name-filter'` on runtime RPC and relay,
   with version negotiation and the legacy fallback chain, so SSH and remote runtime
   environments answer a substring query with an exact total rather than a fuzzy page. Until
   then SSH reports `truncated` without a count, and the pane renders the partial-scan message
   instead of a number.
3. **Local warm inventory — LANDED.** A host-side path inventory keyed by authorized root,
   warmed when the pane loads, invalidated by the local watcher and re-warmed on a debounce,
   with its own path/byte budget and a live-scan fallback past it. It answers the local name
   filter in memory and carries the ignored subset so the pane can drop its own
   `git check-ignore`. Remote hosts keep the live scan (and the check-ignore) until they grow an
   equivalent host-side inventory.

`QUICK_OPEN_LISTING_MAX_RESULTS` is untouched by all three stages. The inventory budget is
separate and deliberately larger — it bounds a cache, not a listing.

## Tests that prove it

- **The regression test for this bug**: a tmpdir with ~25 000 files where the target name is
  placed last in traversal order; assert a query-scoped local search finds it although the
  unscoped 20 001 listing does not. This is a real-filesystem test, not a 300 000-file
  fixture.
- Matcher unit tests: exact `totalCount` past the retention bound, deterministic sort,
  `truncated` semantics, and `no-match` only when the scan was complete.
- UI test: `truncated && files.length === 0` renders the partial-scan message, never "No
  files match this filter".
- Protocol test: a stubbed old host that strips `mode` drives the client down the legacy
  inventory fallback.
- Cancellation: a superseded keystroke kills the prior rg (the pattern already exists for
  `fs:search`).
- Inventory scope: in a real git repo a `.gitignore`d file is absent from `included` and present
  in `all`; the local `fs:searchFilePaths` search excludes it with `includeIgnoredFiles: false`
  and includes it by default.
- Inventory honesty: a query before any warm returns "not warmed", not "no matches"; an
  invalidated entry stops answering until its debounced rebuild lands; the budget predicate
  flips on both path count and retained bytes.
- Renderer: the pane issues no `git check-ignore` while a name filter is active and the host
  supplied the ignored subset.

## Already landed

- **Query-scoped local search.** `NameFilterPathMatcher` (substring-AND, exact `totalCount`,
  a lexicographically-first bounded page so the tree stays a stable sorted prefix) beside
  `QuickOpenPathRanker`; `searchQuickOpenFilePaths` takes `mode`; `fs:searchFilePaths` exposes
  it to the window, with the same `requestToken` cancellation registry as `fs:listFiles`.
- **Both panes use it.** A local non-empty query searches on the host: Quick Open keeps its
  fuzzy matcher and renders the host's truncation flag, the Explore filter asks for
  `name-filter` with a 5 000-path page.
- **Honest presentation.** `getFileExplorerNameFilterEmptyMessageKind` — a truncated listing
  never claims "no files match", it renders the partial-scan message. When the host counted
  matches, the pane says "Showing the first N of M matches".
- **Warm local inventory.** `src/main/ipc/quick-open-path-inventory.ts`, warmed from the pane's
  unscoped listing, invalidated on watcher flush and shutdown, with a budget fallback. The name
  filter's scan scope follows `showGitIgnoredFiles`, so turning ignored files off makes it scan
  exactly what the Contents tab scans.
- `retainQuickOpenPath` and the readdir fallback are untouched, so the unscoped listing keeps
  its OOM bound.
