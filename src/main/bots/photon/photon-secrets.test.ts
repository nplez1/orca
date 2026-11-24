import { describe, expect, it } from 'vitest'
import { assertPhotonKeyCanBeStored, photonCanSealSecrets } from './photon-secrets'

describe('keeping a Photon key', () => {
  it('refuses to keep one where it could only be written base64, and allows a session-only key', () => {
    // A host with a keyring may keep a key; one without must not write it in the clear.
    if (photonCanSealSecrets()) {
      expect(() => assertPhotonKeyCanBeStored(true)).not.toThrow()
    } else {
      expect(() => assertPhotonKeyCanBeStored(true)).toThrow(/cannot seal a key/)
    }
    expect(() => assertPhotonKeyCanBeStored(false)).not.toThrow()
  })
})
