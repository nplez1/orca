// Per-leg bounds for the all-hosts fan-outs, so one slow host cannot hold a merge open.
export const AI_VAULT_ALL_HOST_TIMEOUT_MS = {
  // One reply's bound, and now one page's: a listing is read page by page.
  runtimeScan: 3_000,
  // Why a second bound: a paged listing is several replies, so the single-reply number would end
  // every large history as a partial read — and a partial read never becomes the basis a later
  // refresh diffs against, so it could never converge. A history that still cannot finish in this
  // window shows its rows with an "only part loaded" row and keeps re-reading them here; one load
  // of that host in the single-host view gives both views the basis they diff against.
  //
  // The window bounds the *starts* of pages, so a page that begins just inside it may still run to
  // its own timeout: the merge's worst case is this plus runtimeScan (~23 s), not this alone.
  runtimeScanDrain: 20_000,
  // Why: a remote home with many agent roots routinely needs seconds to walk,
  // stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
  // all-hosts view; the relay gets a real scan budget and the whole leg (relay
  // attempt plus any legacy crawl) stays bounded.
  sshScanRelay: 15_000,
  sshScan: 20_000,
  // A search reads an index rather than walking a home, but it shares the relay
  // with the scans, so it gets the relay budget rather than one of its own.
  search: 15_000
} as const
