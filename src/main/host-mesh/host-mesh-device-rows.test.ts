import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { DeviceRegistry } from '../runtime/rpc/server/pairing/device-registry'

/**
 * One device row per machine the mesh hands an offer to, which is the rule the whole Eject rests on.
 *
 * Why this is pinned here and not only in the mesh's own tests: the failure it prevents is upstream's reuse policy,
 * not this feature's logic. `getOrCreatePendingDevice` coalesces re-advertisement onto one unused offer per
 * (grants, creator) — correct for a QR code an owner shows twice, and wrong for a pass that mints once per member.
 * Two machines sharing one row present one identity to the host that issued it, and revoking that row for either one
 * cuts the other's link for good, with the host still believing the link is active.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-host-mesh-device-rows-'))
})

afterEach(() => {
  removeTreeSync(dir)
})

describe('an offer per member, never one offer shared between two', () => {
  it('returns the same row to a reuse request, so a shared mint would be one identity', () => {
    const registry = new DeviceRegistry(dir)

    const first = registry.getOrCreatePendingDevice('Runtime', 'runtime')
    const second = registry.getOrCreatePendingDevice('Runtime', 'runtime')

    expect(second.deviceId).toBe(first.deviceId)
  })

  it('gives every fresh mint its own row and leaves the earlier offer usable', () => {
    const registry = new DeviceRegistry(dir)

    const laptopsOffer = registry.addDevice('Runtime', 'runtime')
    const vmsOffer = registry.addDevice('Runtime', 'runtime')

    expect(vmsOffer.deviceId).not.toBe(laptopsOffer.deviceId)
    expect(vmsOffer.token).not.toBe(laptopsOffer.token)
    // Both are still live: minting for the second machine must not orphan the first machine's credential, which is
    // what `rotatePendingDevice` would have done.
    expect(registry.validateToken(laptopsOffer.token)).not.toBeNull()
    expect(registry.validateToken(vmsOffer.token)).not.toBeNull()
  })
})
