import { describe, expect, it } from 'vitest'
import {
  SUPERSEDED_ROW_GRACE_MS,
  pruneMeshDeviceRows,
  staleMeshRows,
  type MeshDeviceRowServer
} from './host-mesh-device-row-pruning'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

const row = (
  deviceId: string,
  fields: { lastSeenAt: number; offerExpiresAt?: number; scope?: string }
) => ({ deviceId, scope: fields.scope ?? 'runtime', ...fields })

/**
 * What this pins: a peer that re-joins leaves one row per attempt, and Settings counts every row it was ever
 * seen from as a live link. The fleet's own rule — one row per peer — is only true if the sweep enforces it, and
 * only safe if a row still in use is never the one it drops.
 */
describe('stale mesh device rows', () => {
  it('drops every row a newer one superseded, and keeps the newest', () => {
    const stale = staleMeshRows(
      [
        row('current', { lastSeenAt: NOW - HOUR }),
        row('superseded', { lastSeenAt: NOW - 30 * HOUR }),
        row('superseded-too', { lastSeenAt: NOW - 40 * HOUR })
      ],
      NOW
    )
    expect(stale.map((entry) => entry.deviceId)).toEqual(['superseded', 'superseded-too'])
  })

  it('keeps a second row that is still being refreshed, because a peer may hold two environments', () => {
    const stale = staleMeshRows(
      [row('newest', { lastSeenAt: NOW - HOUR }), row('also-live', { lastSeenAt: NOW - 2 * HOUR })],
      NOW
    )
    expect(stale).toEqual([])
  })

  it('holds a superseded row to the grace window before dropping it', () => {
    const justInside = staleMeshRows(
      [
        row('newest', { lastSeenAt: NOW - HOUR }),
        row('superseded', { lastSeenAt: NOW - HOUR - (SUPERSEDED_ROW_GRACE_MS - HOUR) })
      ],
      NOW
    )
    expect(justInside).toEqual([])
  })

  it('clears an expired offer and leaves an unexpired one scannable', () => {
    const stale = staleMeshRows(
      [
        row('redeemed', { lastSeenAt: NOW - HOUR }),
        row('expired', { lastSeenAt: 0, offerExpiresAt: NOW - HOUR }),
        row('pending', { lastSeenAt: 0, offerExpiresAt: NOW + HOUR }),
        row('no-ttl', { lastSeenAt: 0 })
      ],
      NOW
    )
    expect(stale.map((entry) => entry.deviceId)).toEqual(['expired'])
  })

  it('never touches a row of another scope', () => {
    const stale = staleMeshRows(
      [
        row('current', { lastSeenAt: NOW - HOUR }),
        row('phone', { lastSeenAt: NOW - 90 * HOUR, scope: 'mobile' })
      ],
      NOW
    )
    expect(stale).toEqual([])
  })

  it("groups by peer, so one peer's newest row cannot keep another peer's old rows alive", () => {
    const rows = [
      row('laptop-current', { lastSeenAt: NOW - HOUR }),
      row('laptop-old', { lastSeenAt: NOW - 50 * HOUR }),
      row('studio-current', { lastSeenAt: NOW - 2 * HOUR }),
      row('studio-old', { lastSeenAt: NOW - 60 * HOUR })
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
        ['laptop', ['laptop-current', 'laptop-old']],
        ['studio', ['studio-current', 'studio-old']]
      ])
    )

    expect(revoked).toEqual(['laptop-old', 'studio-old'])
  })
})
