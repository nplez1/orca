import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiHangDiagnosticsStatus } from '../../shared/ui-hang-diagnostics-types'

const { pushMock, consentMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  consentMock: vi.fn()
}))

vi.mock('../observability', () => ({ resolveObservabilityConsent: consentMock }))
vi.mock('../observability/local-file-sink', () => ({
  createLocalFileSink: vi.fn(() => ({
    filePath: '/tmp/ui-hangs.ndjson',
    push: pushMock,
    flush: vi.fn(),
    close: vi.fn()
  }))
}))
vi.mock('../observability/logs-directory', () => ({
  getUiHangLogFilePath: () => '/tmp/ui-hangs.ndjson'
}))

const {
  closeUiHangLogSink,
  getUiHangDiagnosticsStatus,
  normalizeUiHangSample,
  recordMainUiHangSample,
  recordRendererUiHangSample,
  setUiHangLogMeta
} = await import('./ui-hang-log-sink')

const allowed = { localFileEnabled: true, bundleEnabled: true }

beforeEach(() => {
  pushMock.mockClear()
  consentMock.mockReset()
  consentMock.mockReturnValue(allowed)
  setUiHangLogMeta(null)
  closeUiHangLogSink()
})

describe('normalizeUiHangSample', () => {
  it('rejects anything the renderer should not have produced', () => {
    expect(normalizeUiHangSample(null)).toBeNull()
    expect(normalizeUiHangSample('stall')).toBeNull()
    expect(
      normalizeUiHangSample({ signal: 'nope', surface: 'main', durationMs: 1, capturedAtMs: 1 })
    ).toBeNull()
    expect(
      normalizeUiHangSample({ signal: 'stall', surface: 'nope', durationMs: 1, capturedAtMs: 1 })
    ).toBeNull()
    expect(
      normalizeUiHangSample({
        signal: 'stall',
        surface: 'main',
        durationMs: Number.NaN,
        capturedAtMs: 1
      })
    ).toBeNull()
    expect(
      normalizeUiHangSample({ signal: 'stall', surface: 'main', durationMs: 1, capturedAtMs: -1 })
    ).toBeNull()
  })

  it('drops main-only spawn attribution a renderer tries to submit', () => {
    const sample = normalizeUiHangSample({
      signal: 'stall',
      surface: 'main',
      durationMs: 300,
      capturedAtMs: 5,
      visible: true,
      spawns: { 'git status': { count: 9, blockMsTotal: 999, blockMsMax: 999 } }
    })
    expect(sample).not.toBeNull()
    expect(sample).not.toHaveProperty('spawns')
  })

  it('clamps absurd durations and coerces visibility to a boolean', () => {
    const sample = normalizeUiHangSample({
      signal: 'stall',
      surface: 'popout',
      durationMs: 10_000_000_000,
      capturedAtMs: 12,
      visible: 'yes'
    })
    expect(sample).toEqual({
      signal: 'stall',
      surface: 'popout',
      durationMs: 30 * 60 * 1000,
      capturedAtMs: 12,
      visible: false
    })
  })
})

describe('recordRendererUiHangSample', () => {
  it('writes the build/session header as the first line when meta is set', () => {
    setUiHangLogMeta({
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.0.0'
    })
    recordRendererUiHangSample({
      signal: 'stall',
      surface: 'main',
      durationMs: 300,
      capturedAtMs: 5,
      visible: true
    })
    expect(pushMock.mock.calls[0][0]).toMatchObject({
      type: 'ui-hang-meta',
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.0.0'
    })
    expect(pushMock.mock.calls[1][0]).toMatchObject({ type: 'ui-hang', signal: 'stall' })
  })

  it('writes a framed record for a valid sample', () => {
    expect(
      recordRendererUiHangSample({
        signal: 'stall',
        surface: 'main',
        durationMs: 320,
        capturedAtMs: 900,
        visible: true
      })
    ).toBe(true)
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock.mock.calls[0][0]).toMatchObject({
      type: 'ui-hang',
      source: 'renderer',
      signal: 'stall',
      surface: 'main',
      durationMs: 320,
      visible: true
    })
    expect(typeof pushMock.mock.calls[0][0].recordedAt).toBe('string')
  })

  it('drops samples when local file writes are refused by policy', () => {
    consentMock.mockReturnValue({
      localFileEnabled: false,
      bundleEnabled: false,
      disabledReason: 'ci'
    })
    expect(
      recordRendererUiHangSample({
        signal: 'stall',
        surface: 'main',
        durationMs: 320,
        capturedAtMs: 900,
        visible: true
      })
    ).toBe(false)
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('recordMainUiHangSample', () => {
  it('tags main-process samples', () => {
    recordMainUiHangSample({
      signal: 'window-responsive',
      surface: 'main',
      durationMs: 31_000,
      capturedAtMs: 4,
      visible: true
    })
    expect(pushMock.mock.calls[0][0]).toMatchObject({ source: 'main', durationMs: 31_000 })
  })

  it('writes main-stall spawn attribution verbatim', () => {
    recordMainUiHangSample({
      signal: 'main-stall',
      surface: 'main',
      durationMs: 640,
      capturedAtMs: 7,
      visible: true,
      spawns: { 'git status': { count: 2, blockMsTotal: 18.5, blockMsMax: 12 } }
    })
    expect(pushMock.mock.calls[0][0]).toMatchObject({
      signal: 'main-stall',
      spawns: { 'git status': { count: 2, blockMsTotal: 18.5, blockMsMax: 12 } }
    })
  })
})

describe('getUiHangDiagnosticsStatus', () => {
  it('reports enabled with the log path when the setting and consent agree', () => {
    expect(getUiHangDiagnosticsStatus(true)).toEqual<UiHangDiagnosticsStatus>({
      enabled: true,
      logFilePath: '/tmp/ui-hangs.ndjson'
    })
  })

  it('surfaces why an enabled setting cannot write', () => {
    consentMock.mockReturnValue({
      localFileEnabled: false,
      bundleEnabled: false,
      disabledReason: 'orca_diagnostics_disabled'
    })
    expect(getUiHangDiagnosticsStatus(true)).toEqual<UiHangDiagnosticsStatus>({
      enabled: false,
      logFilePath: '/tmp/ui-hangs.ndjson',
      disabledReason: 'orca_diagnostics_disabled'
    })
  })

  it('stays inert when the setting is off', () => {
    expect(getUiHangDiagnosticsStatus(false)).toEqual<UiHangDiagnosticsStatus>({
      enabled: false,
      logFilePath: '/tmp/ui-hangs.ndjson'
    })
  })
})
