import type { RuntimeAiVaultHostInfo } from './ai-vault-runtime-scan'

// Per-leg bounds for the all-hosts fan-outs, so one slow host cannot hold a merge open.
export const AI_VAULT_ALL_HOST_TIMEOUT_MS = {
  // One reply's bound, and now one page's: a listing is read page by page.
  runtimeScan: 3_000,
  // Why a second bound: a paged listing is several replies, so the single-reply number would end
  // every large history as a partial read — and a partial read never becomes the basis a later
  // refresh diffs against, so it could never converge. A history that still cannot finish in this
  // window shows its rows with an "only part loaded" row and keeps re-reading them here; one load
  // of that host in the single-host view gives both views the basis they diff against — unless that
  // host serves a row this build cannot read, which no view diffs against (see hostLegSyncBasis).
  //
  // The window bounds the *starts* of pages, so a page that begins just inside it may still run to
  // its own timeout: the merge's worst case is this plus runtimeScan (~23 s), not this alone.
  runtimeScanDrain: 20_000,
  // Why: the drain window bounds when pages may start, so a tunneled host needs the same
  // widening its single page got — otherwise a large history cannot converge over the tunnel.
  sshTunneledRuntimeScanDrain: 40_000,
  // Why: a remote home with many agent roots routinely needs seconds to walk,
  // stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
  // all-hosts view; a server reached over an SSH tunnel walks the same home
  // plus the tunnel's latency, so it gets a real scan budget.
  sshTunneledRuntimeScan: 15_000,
  // Indexed search shares the connection with scans, so use the same SSH budget.
  search: 15_000
} as const

export function allHostsRuntimeScanTimeoutMs(
  hostInfo: Pick<RuntimeAiVaultHostInfo, 'connectionDependency'>
): number {
  return hostInfo.connectionDependency === 'ssh-tunnel'
    ? AI_VAULT_ALL_HOST_TIMEOUT_MS.sshTunneledRuntimeScan
    : AI_VAULT_ALL_HOST_TIMEOUT_MS.runtimeScan
}

/** The paged-listing window that must match `allHostsRuntimeScanTimeoutMs`'s page bound. */
export function allHostsRuntimeScanDrainMs(
  hostInfo: Pick<RuntimeAiVaultHostInfo, 'connectionDependency'>
): number {
  return hostInfo.connectionDependency === 'ssh-tunnel'
    ? AI_VAULT_ALL_HOST_TIMEOUT_MS.sshTunneledRuntimeScanDrain
    : AI_VAULT_ALL_HOST_TIMEOUT_MS.runtimeScanDrain
}
