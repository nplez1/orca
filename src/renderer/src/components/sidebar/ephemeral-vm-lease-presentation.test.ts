import { describe, expect, it } from 'vitest'
import { resolveEphemeralVmRuntimeLease } from '@/hooks/useEphemeralVmRuntimes'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import {
  EPHEMERAL_VM_LEASE_WARNING_MS,
  resolveEphemeralVmLeaseIndicator,
  type EphemeralVmLeaseIndicator
} from './ephemeral-vm-lease-presentation'

const NOW_MS = Date.parse('2026-10-13T00:00:00Z')
const HOUR_MS = 60 * 60 * 1000

function runtimeRecord(userData: Record<string, string>): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'recipe-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'pair-1',
      projectRoot: '/repo',
      userData
    }
  }
}

function indicatorFor(remainingMs: number, provider?: string): EphemeralVmLeaseIndicator | null {
  const record = runtimeRecord({
    releaseAt: new Date(NOW_MS + remainingMs).toISOString(),
    ...(provider === undefined ? {} : { provider })
  })
  return resolveEphemeralVmLeaseIndicator(resolveEphemeralVmRuntimeLease(record, NOW_MS))
}

describe('resolveEphemeralVmLeaseIndicator', () => {
  it('shows nothing without a lease or without a declared deadline', () => {
    expect(resolveEphemeralVmLeaseIndicator(null)).toBeNull()
    expect(
      resolveEphemeralVmLeaseIndicator(
        resolveEphemeralVmRuntimeLease(runtimeRecord({ provider: 'aws' }), NOW_MS)
      )
    ).toBeNull()
  })

  it('shows nothing for a host that has already been released', () => {
    const released: EphemeralVmRuntimeRecord = {
      ...runtimeRecord({ releaseAt: new Date(NOW_MS + 3 * HOUR_MS).toISOString() }),
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    }

    expect(
      resolveEphemeralVmLeaseIndicator(resolveEphemeralVmRuntimeLease(released, NOW_MS))
    ).toBeNull()
  })

  it('shows nothing for a deadline the contract cannot read', () => {
    expect(
      resolveEphemeralVmLeaseIndicator(
        resolveEphemeralVmRuntimeLease(runtimeRecord({ releaseAt: 'tomorrow' }), NOW_MS)
      )
    ).toBeNull()
  })

  it('summarises hours coarsely and stays muted while more than an hour is left', () => {
    expect(indicatorFor(3 * HOUR_MS, 'aws')).toMatchObject({
      expired: false,
      remaining: '3h',
      tone: 'muted',
      provider: 'aws'
    })
  })

  it('reports minutes and turns destructive inside the last hour', () => {
    expect(indicatorFor(11 * 60 * 1000)).toMatchObject({
      expired: false,
      remaining: '11m',
      tone: 'destructive',
      provider: null
    })
  })

  it('keeps the tone muted at exactly the hour boundary', () => {
    expect(indicatorFor(EPHEMERAL_VM_LEASE_WARNING_MS)).toMatchObject({
      remaining: '1h',
      tone: 'muted'
    })
  })

  it('marks a passed deadline as expired rather than counting it down', () => {
    expect(indicatorFor(-60 * 1000)).toMatchObject({
      expired: true,
      remaining: '0m',
      tone: 'destructive'
    })
  })

  it('floors the summary so it never overstates the time left', () => {
    expect(indicatorFor(3 * HOUR_MS + 59 * 60 * 1000 + 59 * 1000)).toMatchObject({
      remaining: '3h'
    })
  })
})
