import { describe, expect, it } from 'vitest'
import {
  pruneMeshDeviceRows,
  staleMeshRows,
  type MeshDeviceRowServer
} from './host-mesh-device-row-pruning'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

type RowFields = {
  lastSeenAt: number
  offerExpiresAt?: number
  scope?: string
  parentDeviceId?: string
  createdByDeviceId?: string
}

const row = (deviceId: string, fields: RowFields) => ({
  deviceId,
  scope: fields.scope ?? 'runtime',
  ...fields
})

const ids = (rows: readonly { deviceId: string }[]) => rows.map((entry) => entry.deviceId)

/** Mint order is the order the index appended the ids, so the last one is the newest. */
const peer = (...minted: string[]) => ({ all: minted, minted })

/**
 * What this pins: every pass mints a reverse-offer row, a peer redeems it and switches to it, and nothing retired
 * the row it left behind — Settings counted every one of them as an active link. Two properties matter and both are
 * about evidence rather than age:
 *
 *  - the credential is the newest *sighted* row in mint order, and the older ones are spent. Neither `lastSeenAt`
 *    (a disconnect writes it after the replacement was minted) nor `pairedAt` (the same clock as everything else)
 *    can order uses;
 *  - the sweep only ever touches rows this host minted. The row a peer joined through is the owner's link.
 */
describe('stale mesh device rows', () => {
  it('drops every minted row a newer sighted one replaced, on the next pass', () => {
    const rows = [
      row('replaced-too', { lastSeenAt: NOW - 40 * HOUR }),
      row('replaced', { lastSeenAt: NOW - 30 * HOUR }),
      row('current', { lastSeenAt: NOW - HOUR })
    ]
    const stale = staleMeshRows(rows, peer('replaced-too', 'replaced', 'current'), NOW)
    expect(ids(stale)).toEqual(['replaced-too', 'replaced'])
  })

  it('drops a replaced row a minute later — no grace window', () => {
    const rows = [
      row('replaced', { lastSeenAt: NOW - 2 * HOUR }),
      row('current', { lastSeenAt: NOW - 60_000 })
    ]
    expect(ids(staleMeshRows(rows, peer('replaced', 'current'), NOW))).toEqual(['replaced'])
  })

  it('still retires a replaced row whose disconnect stamped it later than the replacement', () => {
    // The peer held a socket on the old token and closed it after redeeming the new one, so `lastSeenAt` says the
    // old row was used most recently. Only the mint order orders the two.
    const rows = [
      row('replaced', { lastSeenAt: NOW - HOUR }),
      row('current', { lastSeenAt: NOW - 3 * HOUR })
    ]
    expect(ids(staleMeshRows(rows, peer('replaced', 'current'), NOW))).toEqual(['replaced'])
  })

  it('keeps a minted row when no replacement has been sighted at all', () => {
    const rows = [
      // The peer redeemed this one and still presents it; a newer offer exists but nobody took it.
      row('in-use', { lastSeenAt: NOW - HOUR }),
      row('never-taken', { lastSeenAt: 0, offerExpiresAt: NOW + HOUR })
    ]
    expect(staleMeshRows(rows, peer('in-use', 'never-taken'), NOW)).toEqual([])
  })

  it('never retires a row this host did not mint — the owner’s own pairing link', () => {
    // The peer joined through this row, so the index holds it, but it was not minted here.
    const rows = [
      row('owners-link', { lastSeenAt: NOW - 50 * HOUR }),
      row('minted-current', { lastSeenAt: NOW - HOUR })
    ]
    const stale = staleMeshRows(
      rows,
      { all: ['owners-link', 'minted-current'], minted: ['minted-current'] },
      NOW
    )
    expect(stale).toEqual([])
  })

  it('leaves a row that other rows were minted from, because revoking it would revoke them', () => {
    const rows = [
      row('replaced-parent', { lastSeenAt: NOW - 40 * HOUR }),
      row('current', { lastSeenAt: NOW - HOUR }),
      row('phone', {
        lastSeenAt: NOW - 2 * HOUR,
        scope: 'mobile',
        parentDeviceId: 'replaced-parent'
      })
    ]
    expect(staleMeshRows(rows, peer('replaced-parent', 'current'), NOW)).toEqual([])
  })

  it('clears an expired offer, keeps one that can still be scanned, and ignores other scopes', () => {
    const rows = [
      row('redeemed', { lastSeenAt: NOW - HOUR }),
      row('expired', { lastSeenAt: 0, offerExpiresAt: NOW - HOUR }),
      row('pending', { lastSeenAt: 0, offerExpiresAt: NOW + HOUR }),
      row('phone', { lastSeenAt: 0, scope: 'mobile' })
    ]
    const stale = staleMeshRows(rows, peer('redeemed', 'expired', 'pending', 'phone'), NOW)
    expect(ids(stale)).toEqual(['expired'])
  })

  it("groups by peer, so one peer's new row cannot retire another peer's", () => {
    const rows = [
      row('laptop-replaced', { lastSeenAt: NOW - 50 * HOUR }),
      row('laptop-current', { lastSeenAt: NOW - HOUR }),
      row('studio-only', { lastSeenAt: NOW - 60 * HOUR })
    ]
    const revoked: string[] = []
    const server: MeshDeviceRowServer = {
      getDeviceRegistry: () => ({ listDevices: () => rows, removeDevice: () => true }),
      revokeRuntimeAccess: (deviceId: string) => {
        revoked.push(deviceId)
        return true
      }
    }

    pruneMeshDeviceRows(
      server,
      new Map([
        ['laptop', peer('laptop-replaced', 'laptop-current')],
        // Alone in its group: the newest credential it has, and there is nothing to replace it.
        ['studio', peer('studio-only')]
      ])
    )

    expect(revoked).toEqual(['laptop-replaced'])
  })

  it('forgets an id whose row the registry no longer has, so the entry cannot drift', () => {
    const server: MeshDeviceRowServer = {
      getDeviceRegistry: () => ({ listDevices: () => [], removeDevice: () => false }),
      revokeRuntimeAccess: () => false
    }
    expect(pruneMeshDeviceRows(server, new Map([['laptop', peer('gone-1', 'gone-2')]]))).toEqual([
      'gone-1',
      'gone-2'
    ])
  })

  it('falls back to deleting the row when the full revoke throws or declines', () => {
    const rows = [
      row('replaced', { lastSeenAt: NOW - HOUR }),
      row('current', { lastSeenAt: NOW - HOUR })
    ]
    const removed: string[] = []
    let calls = 0
    const server: MeshDeviceRowServer = {
      getDeviceRegistry: () => ({
        listDevices: () =>
          rows
            .map((entry) => (removed.includes(entry.deviceId) ? undefined : entry))
            .filter((entry) => entry !== undefined),
        removeDevice: (deviceId: string) => {
          removed.push(deviceId)
          return true
        }
      }),
      // Throws for the first candidate, declines the second: both must still end with a deleted row.
      revokeRuntimeAccess: () => {
        calls += 1
        if (calls === 1) {
          throw new Error('registry refused')
        }
        return false
      }
    }

    const dropped = pruneMeshDeviceRows(server, new Map([['laptop', peer('replaced', 'current')]]))
    expect(dropped).toEqual(['replaced'])
    expect(removed).toEqual(['replaced'])
  })
})
