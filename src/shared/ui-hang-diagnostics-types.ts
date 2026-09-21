// Wire + on-disk shape for the opt-in UI-hang log (Settings → Advanced → Debug Options).
// The renderer is untrusted: main normalizes every field at the IPC boundary, so nothing
// here may carry free text, URLs, terminal contents, or account data.

/** Which process measured the sample. `main` is the main process observing its own window. */
export type UiHangSource = 'renderer' | 'main'

/**
 * `stall` is the renderer measuring its own UI thread via an interval watchdog; `main-stall`
 * is the same measurement on the main process, where a blocked event loop freezes IPC and
 * terminal input even though the renderer keeps painting. `window-unresponsive`/
 * `window-responsive` are Electron's coarse window signals, where only the `responsive`
 * record carries the recovered duration.
 */
export type UiHangSignal = 'stall' | 'main-stall' | 'window-unresponsive' | 'window-responsive'

/** Which document produced the sample. Only local desktop windows emit these. */
export type UiHangSurface = 'main' | 'popout' | 'webview'

/**
 * Synchronous subprocess-spawn cost seen on the main thread during the stall window, keyed by
 * a stable command bucket such as `git status`. Main-process only — the renderer cannot submit
 * these, and the buckets carry no arguments, paths, or URLs.
 */
export type UiHangSpawnAttribution = Record<
  string,
  { count: number; blockMsTotal: number; blockMsMax: number }
>

/**
 * One sample. Main adds `type`/`source`/`recordedAt` when it writes the record, so the
 * renderer never controls the file's framing.
 */
export type UiHangSample = {
  signal: UiHangSignal
  /** Milliseconds the UI thread was blocked; 0 when the signal carries no duration. */
  durationMs: number
  surface: UiHangSurface
  /** Whether the emitting document/window was visible at capture. */
  visible: boolean
  /** `performance.now()` in the emitting process (not comparable across processes). */
  capturedAtMs: number
  /** Present on `main-stall` records when spawns blocked the main thread; omit when empty. */
  spawns?: UiHangSpawnAttribution
}

/** NDJSON line written to `logs/ui-hangs.ndjson`. */
export type UiHangLogRecord = UiHangSample & {
  type: 'ui-hang'
  source: UiHangSource
  /** Wall-clock at ingest, ISO-8601. */
  recordedAt: string
}

/** Build/session identity, so a collected log can be traced back to a release and platform. */
export type UiHangLogMeta = {
  appVersion: string
  platform: string
  arch: string
  osRelease: string
}

/** First line of a log file, written once when the sink opens. */
export type UiHangLogMetaRecord = UiHangLogMeta & {
  type: 'ui-hang-meta'
  recordedAt: string
}

/** Read-only status the Debug Options pane renders. */
export type UiHangDiagnosticsStatus = {
  /** Whether the user's setting is on *and* local diagnostics are permitted. */
  enabled: boolean
  logFilePath: string
  /** Present when the setting is on but local file writes are refused by policy. */
  disabledReason?: 'ci' | 'orca_diagnostics_disabled'
}
