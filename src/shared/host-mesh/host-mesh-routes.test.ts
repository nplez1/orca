import { describe, expect, it } from 'vitest'
import { HOST_MESH_MAX_ENDPOINT_CANDIDATES } from './host-mesh-contract'
import { dialCandidates, isDialableEndpoint, rememberRoutes } from './host-mesh-routes'

const LAN = 'ws://192.168.1.20:6768'
const LAN2 = 'ws://192.168.1.21:6768'
const TAILNET = 'ws://100.98.144.27:6768'

describe('keeping a member’s routes', () => {
  it('keeps the address a member published and the one it left behind', () => {
    // Why this matters: turning Tailscale off leaves a host reporting only its LAN address, and the tailnet one is
    // what a pass needs the moment the net comes back.
    expect(rememberRoutes({ previous: [TAILNET, LAN], reported: [LAN] })).toEqual([LAN, TAILNET])
  })

  it('never keeps the same address twice, or more than an offer may carry', () => {
    const reported = [LAN, LAN, LAN2, TAILNET, LAN]
    const kept = rememberRoutes({ reported })

    expect(kept).toEqual([...new Set(kept)])
    expect(kept.length).toBeLessThanOrEqual(HOST_MESH_MAX_ENDPOINT_CANDIDATES)
  })

  it('refuses anything that is not an endpoint this host would dial', () => {
    // A peer's words are not this host's input: a value that cannot be dialed would be recorded as a failed path.
    expect(isDialableEndpoint(LAN)).toBe(true)
    expect(isDialableEndpoint('http://192.168.1.20:6768')).toBe(false)
    expect(isDialableEndpoint('ws://user:pass@192.168.1.20:6768')).toBe(false)
    expect(isDialableEndpoint('nonsense')).toBe(false)
    expect(rememberRoutes({ reported: ['nonsense', LAN] })).toEqual([LAN])
  })

  it('keeps what it already had when a member reports nothing', () => {
    expect(rememberRoutes({ previous: [LAN] })).toEqual([LAN])
  })
})

describe('which route to try after one failed', () => {
  it('skips the address that just failed and keeps the order the member published', () => {
    expect(dialCandidates({ current: LAN, routes: [LAN, LAN2, TAILNET] })).toEqual([LAN2, TAILNET])
  })

  it('has nothing to try for a member that never published an address', () => {
    expect(dialCandidates({ current: LAN, routes: undefined })).toEqual([])
  })
})
