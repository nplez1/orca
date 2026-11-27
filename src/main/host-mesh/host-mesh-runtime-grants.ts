import { isExpiredPairingOffer, type DeviceEntry } from '../runtime/rpc/server/pairing/device-entry'

/**
 * Whether a device row is a runtime link the owner can still act on.
 *
 * Why it lives here: an offer past its TTL can pair nothing, and the mesh mints one per reverse offer it cannot
 * complete, so an expired row would otherwise read as a link forever. A live unredeemed offer still counts —
 * it is revocable and still scannable.
 */
export function isLiveRuntimeGrant(device: DeviceEntry): boolean {
  return device.scope === 'runtime' && !isExpiredPairingOffer(device, Date.now())
}
