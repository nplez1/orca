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
    const reported = [LAN, LAN2, TAILNET, 'ws://192.168.1.22:6768', LAN]
    const kept = rememberRoutes({ reported })

    expect(kept).toEqual([...new Set(kept)])
    expect(kept.length).toBe(HOST_MESH_MAX_ENDPOINT_CANDIDATES)
  })

  it('spends one slot on the address a failed dial would fall back on', () => {
    // Why: a machine reporting a full set would otherwise erase every address held before, and the one address a
    // failed path has to try is exactly the one that was held before.
    const previous = [TAILNET]
    const reported = [LAN, LAN2, 'ws://192.168.1.22:6768', 'ws://192.168.1.23:6768']

    const kept = rememberRoutes({ previous, reported })

    expect(kept).toHaveLength(HOST_MESH_MAX_ENDPOINT_CANDIDATES)
    expect(kept).toContain(TAILNET)
    expect(kept[0]).toBe(LAN)
  })

  it('keeps carrying that fallback on the report after it, not just the one that dropped it', () => {
    // Why the second round matters: the address a report leaves behind becomes "previous" on the next one, so a
    // reservation that only looked at the best previous entry would drop it exactly one pass later.
    const reported = [LAN, LAN2, 'ws://192.168.1.22:6768', 'ws://192.168.1.23:6768']
    const first = rememberRoutes({ previous: [TAILNET], reported })
    const second = rememberRoutes({ previous: first, reported })

    expect(first).toContain(TAILNET)
    expect(second).toContain(TAILNET)
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
