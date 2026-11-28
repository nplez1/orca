import { describe, expect, it } from 'vitest'
import {
  pruneMeshDeviceRows,
  staleMeshRows,
  type MeshDeviceRowServer
} from './host-mesh-device-row-pruning'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

type RowFields = {
  pairedAt: number
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
const mintedOf = (...deviceIds: string[]) => new Set(deviceIds)

/**
 * What this pins: every pass mints a reverse-offer row, a peer redeems it and switches to it, and nothing retired
 * the row it left behind — Settings counted every one of them as an active link. Two properties matter and both are
 * about evidence rather than age:
 *
 *  - the row the peer chose is the newest *sighted* minted row, and the older ones are spent (no `lastSeenAt`
 *    comparison, because a disconnect writes that stamp after the replacement was minted);
 *  - the sweep only ever touches rows this host minted. The row a peer joined through is the owner's link.
 */
describe('stale mesh device rows', () => {
  it('drops every minted row a newer sighted one replaced, on the next pass', () => {
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
        row('replaced', { pairedAt: NOW - 30 * HOUR, lastSeenAt: NOW - 30 * HOUR + 1000 }),
        row('replaced-too', { pairedAt: NOW - 40 * HOUR, lastSeenAt: NOW - 40 * HOUR + 1000 })
      ],
      mintedOf('current', 'replaced', 'replaced-too'),
      NOW
    )
    expect(ids(stale)).toEqual(['replaced', 'replaced-too'])
  })

  it('drops a replaced row a minute later — no grace window', () => {
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - HOUR, lastSeenAt: NOW - 60_000 }),
        row('replaced', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - 2 * HOUR + 1000 })
      ],
      mintedOf('current', 'replaced'),
      NOW
    )
    expect(ids(stale)).toEqual(['replaced'])
  })

  it('still retires a replaced row whose disconnect stamped it later than the replacement', () => {
    // The peer held a socket on the old token and closed it after redeeming the new one, so `lastSeenAt` says the
    // old row was used most recently. Only the stamp it was minted with orders the two.
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - 3 * HOUR }),
        row('replaced', { pairedAt: NOW - 9 * HOUR, lastSeenAt: NOW - HOUR })
      ],
      mintedOf('current', 'replaced'),
      NOW
    )
    expect(ids(stale)).toEqual(['replaced'])
  })

  it('keeps a minted row when no replacement has been sighted at all', () => {
    const stale = staleMeshRows(
      [
        // The peer redeemed this one and still presents it; a newer offer exists but nobody took it.
        row('in-use', { pairedAt: NOW - 9 * HOUR, lastSeenAt: NOW - HOUR }),
        row('never-taken', {
          pairedAt: NOW - 30 * 60_000,
          lastSeenAt: 0,
          offerExpiresAt: NOW + HOUR
        })
      ],
      mintedOf('in-use', 'never-taken'),
      NOW
    )
    expect(stale).toEqual([])
  })

  it('never retires a row this host did not mint — the owner’s own pairing link', () => {
    // The peer joined through this row, so the index holds it, but it was not minted here.
    const stale = staleMeshRows(
      [
        row('minted-current', { pairedAt: NOW - HOUR, lastSeenAt: NOW - HOUR }),
        row('owners-link', { pairedAt: NOW - 60 * HOUR, lastSeenAt: NOW - 50 * HOUR })
      ],
      mintedOf('minted-current'),
      NOW
    )
    expect(stale).toEqual([])
  })

  it('leaves a row that other rows were minted from, because revoking it would revoke them', () => {
    const rows = [
      row('current', { pairedAt: NOW - HOUR, lastSeenAt: NOW - HOUR }),
      row('replaced-parent', { pairedAt: NOW - 40 * HOUR, lastSeenAt: NOW - 40 * HOUR + 1000 }),
      row('phone', {
        pairedAt: NOW - 39 * HOUR,
        lastSeenAt: NOW - 2 * HOUR,
        scope: 'mobile',
        parentDeviceId: 'replaced-parent'
      })
    ]
    const stale = staleMeshRows(rows, mintedOf('current', 'replaced-parent'), NOW)
    expect(stale).toEqual([])
  })

  it('clears an expired offer, keeps one that can still be scanned, and ignores other scopes', () => {
    const stale = staleMeshRows(
      [
        row('redeemed', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
        row('expired', { pairedAt: NOW - 2 * HOUR, lastSeenAt: 0, offerExpiresAt: NOW - HOUR }),
        row('pending', { pairedAt: NOW - 60_000, lastSeenAt: 0, offerExpiresAt: NOW + HOUR }),
        row('phone', { pairedAt: NOW - 90 * HOUR, lastSeenAt: 0, scope: 'mobile' })
      ],
      mintedOf('redeemed', 'expired', 'pending', 'phone'),
      NOW
    )
    expect(ids(stale)).toEqual(['expired'])
  })

  it("groups by peer, so one peer's new row cannot retire another peer's", () => {
    const rows = [
      row('laptop-current', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
      row('laptop-replaced', { pairedAt: NOW - 50 * HOUR, lastSeenAt: NOW - 50 * HOUR + 1000 }),
      row('studio-only', { pairedAt: NOW - 60 * HOUR, lastSeenAt: NOW - 60 * HOUR + 1000 })
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
        [
          'laptop',
          {
            all: ['laptop-current', 'laptop-replaced'],
            minted: ['laptop-current', 'laptop-replaced']
          }
        ],
        // Alone in its group: the newest credential it has, and there is nothing to replace it.
        ['studio', { all: ['studio-only'], minted: ['studio-only'] }]
      ])
    )

    expect(revoked).toEqual(['laptop-replaced'])
  })

  it('falls back to removing the row when the full revoke declines it', () => {
    const rows = [row('current', { pairedAt: NOW - HOUR, lastSeenAt: NOW - HOUR })]
    const removed: string[] = []
    const server: MeshDeviceRowServer = {
      getDeviceRegistry: () => ({
        listDevices: () => rows,
        removeDevice: (deviceId: string) => {
          removed.push(deviceId)
          return true
        }
      }),
      revokeRuntimeAccess: () => false
    }
    expect(pruneMeshDeviceRows(server, new Map())).toEqual([])
    expect(removed).toEqual([])
  })
})
