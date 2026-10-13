import { describe, expect, it } from 'vitest'
import {
  decideEphemeralVmRuntimeReclaim,
  EPHEMERAL_VM_RECLAIM_GRACE_MS,
  type EphemeralVmReclaimInput
} from './ephemeral-vm-runtime-reclaim'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'

const RELEASE_AT = '2026-10-13T03:26:41Z'
const RELEASE_AT_MS = Date.parse(RELEASE_AT)

function pairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function runtime(overrides: Partial<EphemeralVmReclaimInput> = {}): EphemeralVmReclaimInput {
  return {
    status: 'running',
    cleanupStatus: 'not_started',
    recipeResult: {
      schemaVersion: 1,
      pairingCode: pairingCode(),
      projectRoot: '/workspace/repo',
      userData: { provider: 'aws', resourceId: 'i-0123456789', releaseAt: RELEASE_AT }
    },
    ...overrides
  }
}

function decide(
  overrides: Partial<EphemeralVmReclaimInput>,
  nowMs: number,
  connectionExhausted: boolean
): ReturnType<typeof decideEphemeralVmRuntimeReclaim> {
  return decideEphemeralVmRuntimeReclaim({
    runtime: runtime(overrides),
    nowMs,
    connectionExhausted
  })
}

describe('decideEphemeralVmRuntimeReclaim', () => {
  it('declines when the recipe published no provider deadline', () => {
    const userDataValues: (Record<string, string | number> | undefined)[] = [
      undefined,
      { provider: 'aws' },
      { provider: 'aws', resourceId: 'i-1', lifetimeSeconds: 3_600 },
      { resourceId: 'i-1' }
    ]
    for (const userData of userDataValues) {
      const base = {
        schemaVersion: 1 as const,
        pairingCode: pairingCode(),
        projectRoot: '/workspace/repo'
      }
      expect(
        decide(
          { recipeResult: userData ? { ...base, userData } : base },
          RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS + 1,
          true
        )
      ).toEqual({ reclaim: false, reason: 'no-provider-deadline' })
    }
  })

  it('declines a malformed releaseAt as having no usable deadline', () => {
    // Why: readEphemeralVmLifetime fails closed here, and the reclaim decision treats an
    // unreadable deadline the same as a missing one rather than guessing a moment to reclaim at.
    const verdict = decide(
      {
        recipeResult: {
          schemaVersion: 1,
          pairingCode: pairingCode(),
          projectRoot: '/workspace/repo',
          userData: { releaseAt: 'tomorrow' }
        }
      },
      RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS * 100,
      true
    )

    expect(verdict).toEqual({ reclaim: false, reason: 'no-provider-deadline' })
  })

  it.each([
    ['a cleaned runtime', { status: 'cleaned' as const }],
    ['a runtime already pending cleanup', { status: 'cleanup_pending' as const }],
    ['a runtime whose cleanup already succeeded', { cleanupStatus: 'succeeded' as const }]
  ])('declines %s rather than racing the attempt already running', (_label, overrides) => {
    expect(decide(overrides, RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS, true)).toEqual({
      reclaim: false,
      reason: 'already-reclaimed'
    })
  })

  it('declines inside the lease, including at the exact deadline', () => {
    for (const [nowMs, label] of [
      [RELEASE_AT_MS - EPHEMERAL_VM_RECLAIM_GRACE_MS, 'well before the deadline'],
      [RELEASE_AT_MS - 1, 'just before the deadline'],
      [RELEASE_AT_MS, 'at the deadline'],
      [RELEASE_AT_MS + 1, 'just past the deadline'],
      [RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS - 1, 'inside the grace']
    ] as const) {
      expect(decide({}, nowMs, true), label).toEqual({ reclaim: false, reason: 'within-lease' })
    }
  })

  it('declines past the grace when Orca holds no evidence the host is gone', () => {
    // Why: loss of contact is never evidence of absence, so an unreachable host may still be alive.
    for (const nowMs of [
      RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS,
      RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS + 1,
      RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS * 24
    ]) {
      expect(decide({}, nowMs, false)).toEqual({ reclaim: false, reason: 'host-may-return' })
    }
  })

  it('reclaims at exactly the deadline plus the grace, once the connection is exhausted', () => {
    expect(decide({}, RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS, true)).toEqual({
      reclaim: true,
      reason: 'provider-lease-expired',
      lifetime: {
        provider: 'aws',
        resourceId: 'i-0123456789',
        releaseAt: RELEASE_AT,
        releaseAtMs: RELEASE_AT_MS
      }
    })
  })

  it('does not reclaim one millisecond before the grace elapses', () => {
    expect(decide({}, RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS - 1, true)).toEqual({
      reclaim: false,
      reason: 'within-lease'
    })
  })

  it.each([
    ['a cleaned runtime', { status: 'cleaned' as const }],
    ['a runtime already pending cleanup', { status: 'cleanup_pending' as const }],
    ['a runtime whose cleanup already succeeded', { cleanupStatus: 'succeeded' as const }]
  ])('reports already-reclaimed ahead of an expired deadline for %s', (_label, overrides) => {
    // Why: the already-reclaimed check runs first, so a finished cleanup is never re-decided
    // against a provider deadline that has since passed.
    expect(decide(overrides, RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS * 10, true)).toEqual({
      reclaim: false,
      reason: 'already-reclaimed'
    })
  })

  it('returns the lifetime the recipe reported, so the caller can name the deadline', () => {
    const verdict = decide(
      {
        recipeResult: {
          schemaVersion: 1,
          pairingCode: pairingCode(),
          projectRoot: '/workspace/repo',
          userData: {
            provider: 'fly',
            resourceId: 'machine-1',
            releaseAt: RELEASE_AT,
            lifetimeSeconds: 7_200
          }
        }
      },
      RELEASE_AT_MS + EPHEMERAL_VM_RECLAIM_GRACE_MS,
      true
    )

    expect(verdict).toMatchObject({
      reclaim: true,
      lifetime: { provider: 'fly', resourceId: 'machine-1', lifetimeSeconds: 7_200 }
    })
  })
})
