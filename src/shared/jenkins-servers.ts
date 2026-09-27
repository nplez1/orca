/**
 * The Jenkins servers a user has configured.
 *
 * A user runs several Jenkins instances (one per product, or a per-team server), so this is a list
 * rather than a single connection. Only the API token is a secret and lives in the encrypted
 * credential file; these profiles are plain metadata.
 */

export type JenkinsServerProfile = {
  id: string
  /** Display name chosen by the user, defaulting to the server host. */
  label: string
  /** Normalized base URL, including any path prefix Jenkins is served under. */
  baseUrl: string
  /** Jenkins user id the API token belongs to; empty means the token is sent as a bearer token. */
  username: string
}

export type JenkinsServerSummary = JenkinsServerProfile & {
  /** Whether a token is stored. The token itself never reaches the renderer. */
  hasToken: boolean
}

export type JenkinsSaveServerArgs = {
  /** Existing server to update; omitted to add a new one. */
  id?: string
  label: string
  baseUrl: string
  username: string
  /** Omit or leave empty to keep the token already stored for this server. */
  apiToken?: string
}

export type JenkinsSaveServerResult =
  | { ok: true; server: JenkinsServerSummary }
  | { ok: false; error: string }

export type JenkinsServerTestResult =
  | { ok: true; version: string | null }
  | { ok: false; error: string }
