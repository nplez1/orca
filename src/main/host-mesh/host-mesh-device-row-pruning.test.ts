import { describe, expect, it } from 'vitest'
import {
  pruneMeshDeviceRows,
  staleMeshRows,
  type MeshDeviceRowServer
} from './host-mesh-device-row-pruning'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

const row = (
  deviceId: string,
  fields: {
    pairedAt: number
    lastSeenAt: number
    offerExpiresAt?: number
    scope?: string
  }
) => ({ deviceId, scope: fields.scope ?? 'runtime', ...fields })

const ids = (rows: readonly { deviceId: string }[]) => rows.map((entry) => entry.deviceId)

/**
 * What this pins: every reverse offer mints a device row, Settings counts every row a peer was ever seen from as
 * a live link, and nothing retires the row a later one replaced. The fleet's own rule — one credential per peer —
 * holds only if a row with no sighting since its replacement was minted is dropped at once, while a row still in
 * use is kept however old it is.
 */
describe('stale mesh device rows', () => {
  it('drops every row a newer one replaced, on the next pass', () => {
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
        row('replaced', { pairedAt: NOW - 30 * HOUR, lastSeenAt: NOW - 30 * HOUR + 1000 }),
        row('replaced-too', { pairedAt: NOW - 40 * HOUR, lastSeenAt: NOW - 40 * HOUR + 1000 })
      ],
      NOW
    )
    expect(ids(stale)).toEqual(['replaced', 'replaced-too'])
  })

  it('drops a row replaced a minute ago — no grace window', () => {
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - HOUR, lastSeenAt: NOW - 60_000 }),
        row('replaced', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - 2 * HOUR + 1000 })
      ],
      NOW
    )
    expect(ids(stale)).toEqual(['replaced'])
  })

  it('keeps a row a peer is still using after its replacement was minted, however old it is', () => {
    const stale = staleMeshRows(
      [
        row('newer', { pairedAt: NOW - 5 * HOUR, lastSeenAt: NOW - 4 * HOUR }),
        // Sighted an hour ago: last week's row, still the token one environment presents.
        row('older-but-used', { pairedAt: NOW - 170 * HOUR, lastSeenAt: NOW - HOUR })
      ],
      NOW
    )
    expect(stale).toEqual([])
  })

  it('clears an expired offer and leaves an unexpired one scannable', () => {
    const stale = staleMeshRows(
      [
        row('redeemed', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
        row('expired', { pairedAt: NOW - 2 * HOUR, lastSeenAt: 0, offerExpiresAt: NOW - HOUR }),
        row('pending', { pairedAt: NOW - HOUR, lastSeenAt: 0, offerExpiresAt: NOW + HOUR }),
        // No TTL at all: a headless offer the owner minted, which never expires on its own.
        row('no-ttl', { pairedAt: NOW - HOUR, lastSeenAt: 0 })
      ],
      NOW
    )
    expect(ids(stale)).toEqual(['expired'])
  })

  it('never touches a row of another scope', () => {
    const stale = staleMeshRows(
      [
        row('current', { pairedAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR }),
        row('phone', { pairedAt: NOW - 90 * HOUR, lastSeenAt: NOW - 90 * HOUR, scope: 'mobile' })
      ],
      NOW
    )
    expect(stale).toEqual([])
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
        ['laptop', ['laptop-current', 'laptop-replaced']],
        // Alone in its group: the newest credential it has, and there is nothing to replace it.
        ['studio', ['studio-only']]
      ])
    )

    expect(revoked).toEqual(['laptop-replaced'])
  })
})
