import { describe, expect, it } from 'vitest'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from './local-build-compatibility-contract'
import {
  ORCAD_BROWSER_PARK_LABEL,
  SERVE_LAUNCHD_LABEL_PREFIX,
  isServeSupervisorLabel,
  parseServeSupervisorRegistration
} from './serve-bundle-coordination'

describe('serve supervisor labels', () => {
  // Why: a fixed upstream prefix made `serve service install` replace and delete the official
  // install's `com.stablyai.orca.serve.plist` on every run.
  it('namespaces this build under its own appId', () => {
    expect(SERVE_LAUNCHD_LABEL_PREFIX).toBe(`${LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId}.serve`)
    expect(SERVE_LAUNCHD_LABEL_PREFIX.startsWith('com.stablyai.orca')).toBe(false)
    expect(ORCAD_BROWSER_PARK_LABEL.startsWith(`${SERVE_LAUNCHD_LABEL_PREFIX}.`)).toBe(true)
  })

  it('still recognises a supervisor a pre-rename build registered', () => {
    expect(isServeSupervisorLabel(SERVE_LAUNCHD_LABEL_PREFIX)).toBe(true)
    expect(isServeSupervisorLabel(`${SERVE_LAUNCHD_LABEL_PREFIX}.1a2b3c4d`)).toBe(true)
    expect(isServeSupervisorLabel('com.stablyai.orca.serve.default')).toBe(true)
  })

  it('rejects a label this build does not own', () => {
    expect(isServeSupervisorLabel(`${SERVE_LAUNCHD_LABEL_PREFIX}x`)).toBe(false)
    expect(isServeSupervisorLabel('com.example.other.serve')).toBe(false)
    expect(isServeSupervisorLabel(undefined)).toBe(false)
  })

  it('parses a registration under either prefix', () => {
    const registration = {
      protocol: 1,
      pid: 42,
      childPid: null,
      heartbeatAt: 1,
      label: `${SERVE_LAUNCHD_LABEL_PREFIX}.1a2b3c4d`
    }
    expect(parseServeSupervisorRegistration(registration)).toEqual(registration)
    expect(
      parseServeSupervisorRegistration({ ...registration, label: 'com.stablyai.orca.serve' })
    ).toMatchObject({ label: 'com.stablyai.orca.serve' })
    expect(
      parseServeSupervisorRegistration({ ...registration, label: 'com.example.serve' })
    ).toBeNull()
  })
})
