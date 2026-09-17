// Per-leg bounds for the all-hosts fan-outs, so one slow host cannot hold a merge open.
export const AI_VAULT_ALL_HOST_TIMEOUT_MS = {
  runtimeScan: 3_000,
  // Why: a remote home with many agent roots routinely needs seconds to walk,
  // stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
  // all-hosts view; the relay gets a real scan budget and the whole leg (relay
  // attempt plus any legacy crawl) stays bounded.
  sshScanRelay: 15_000,
  sshScan: 20_000,
  // Why: a merged search must outlive the host's own 5s `wait-until-current`
  // window (session-search-service-registry) or that flag never arrives, and
  // search reads a warm index, so a scan-sized budget would only wait on a
  // relay that is not coming back. Applied to local, SSH and runtime legs alike.
  searchLeg: 8_000
} as const
