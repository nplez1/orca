// Opt-in UI-hang log (Settings → Advanced → Debug Options). Enabled by the
// `uiHangDiagnosticsEnabled` setting; the rotating NDJSON sink stays lazy so a disabled app
// never opens the file.
//
// Sources: the renderer stall probe (`lib/ui-hang-diagnostics/probe.ts`), the main-process
// stall probe (`main-thread-stall-probe.ts`), and Electron window `unresponsive` events
// (`window/ui-hang-window-observer.ts`).
//
// Still separate on purpose: `main-thread-churn-probe.ts` aggregates stalls to stderr under
// ORCA_MAIN_THREAD_DIAGNOSTICS, and `hang-watchdog/` writes a macOS next-launch marker.
// Neither is controlled by this setting.

import { resolveObservabilityConsent } from '../observability'
import { createLocalFileSink, type LocalFileSink } from '../observability/local-file-sink'
import { getUiHangLogFilePath } from '../observability/logs-directory'
import type {
  UiHangDiagnosticsStatus,
  UiHangLogMeta,
  UiHangLogMetaRecord,
  UiHangLogRecord,
  UiHangSample,
  UiHangSignal,
  UiHangSource,
  UiHangSurface
} from '../../shared/ui-hang-diagnostics-types'

// Stalls are rare (>250ms), so a small family is plenty and keeps the footprint bounded.
const MAX_BYTES = 5 * 1024 * 1024
const MAX_FILES = 5
// Anything longer than this is a suspended/partitioned process, not a UI hang worth charting.
const MAX_DURATION_MS = 30 * 60 * 1000

const SIGNALS: ReadonlySet<string> = new Set<UiHangSignal>([
  'stall',
  'main-stall',
  'window-unresponsive',
  'window-responsive'
])
const SURFACES: ReadonlySet<string> = new Set<UiHangSurface>(['main', 'popout', 'webview'])

function isUiHangSignal(value: unknown): value is UiHangSignal {
  return typeof value === 'string' && SIGNALS.has(value)
}

function isUiHangSurface(value: unknown): value is UiHangSurface {
  return typeof value === 'string' && SURFACES.has(value)
}

let sink: LocalFileSink | null = null
let logMeta: UiHangLogMeta | null = null

/**
 * Build/session identity written as the file's first line. Set once at startup by the
 * composition root; null (e.g. in tests) simply omits the header.
 */
export function setUiHangLogMeta(meta: UiHangLogMeta | null): void {
  logMeta = meta
}

function openSink(): LocalFileSink {
  if (!sink) {
    sink = createLocalFileSink({
      filePath: getUiHangLogFilePath(),
      maxBytes: MAX_BYTES,
      maxFiles: MAX_FILES
    })
    if (logMeta) {
      const header: UiHangLogMetaRecord = {
        type: 'ui-hang-meta',
        recordedAt: new Date().toISOString(),
        ...logMeta
      }
      sink.push(header)
    }
  }
  return sink
}

/**
 * Narrow one untrusted renderer sample. Returns null on any shape the renderer should never
 * have produced, so junk IPC cannot write arbitrary payloads into the log.
 */
export function normalizeUiHangSample(input: unknown): UiHangSample | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('signal' in input) ||
    !('surface' in input) ||
    !('durationMs' in input) ||
    !('capturedAtMs' in input) ||
    !('visible' in input)
  ) {
    return null
  }
  const { signal, surface, durationMs, capturedAtMs, visible } = input
  if (!isUiHangSignal(signal) || !isUiHangSurface(surface)) {
    return null
  }
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return null
  }
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs) || capturedAtMs < 0) {
    return null
  }
  return {
    signal,
    durationMs: Math.max(0, Math.min(MAX_DURATION_MS, durationMs)),
    surface,
    visible: visible === true,
    capturedAtMs
  }
}

/** Local file writes are refused under CI / ORCA_DIAGNOSTICS_DISABLED, same boundary the trace lane honors. */
export function isUiHangLogAllowed(): boolean {
  return resolveObservabilityConsent().localFileEnabled
}

/** Status the Debug Options pane renders. `requested` is the persisted setting. */
export function getUiHangDiagnosticsStatus(requested: boolean): UiHangDiagnosticsStatus {
  const consent = resolveObservabilityConsent()
  const enabled = requested && consent.localFileEnabled
  const blockedReason =
    consent.disabledReason === 'ci' || consent.disabledReason === 'orca_diagnostics_disabled'
      ? consent.disabledReason
      : undefined
  return {
    enabled,
    logFilePath: getUiHangLogFilePath(),
    ...(requested && !enabled && blockedReason ? { disabledReason: blockedReason } : {})
  }
}

function writeRecord(source: UiHangSource, sample: UiHangSample): void {
  const record: UiHangLogRecord = {
    type: 'ui-hang',
    source,
    recordedAt: new Date().toISOString(),
    ...sample
  }
  openSink().push(record)
}

/**
 * Ingest one renderer sample over IPC. Returns whether it was accepted, which is enough for
 * the renderer to stay fire-and-forget. No-op while local diagnostics are refused.
 */
export function recordRendererUiHangSample(input: unknown): boolean {
  if (!isUiHangLogAllowed()) {
    return false
  }
  const sample = normalizeUiHangSample(input)
  if (!sample) {
    return false
  }
  writeRecord('renderer', sample)
  return true
}

/** Ingest one main-process sample (window responsiveness, main-thread stalls). */
export function recordMainUiHangSample(sample: UiHangSample): void {
  if (!isUiHangLogAllowed()) {
    return
  }
  writeRecord('main', sample)
}

/** Flush buffered lines synchronously — called from shutdown before the sink closes. */
export function closeUiHangLogSink(): void {
  if (!sink) {
    return
  }
  sink.close()
  sink = null
}
