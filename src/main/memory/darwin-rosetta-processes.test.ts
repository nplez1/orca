import { describe, expect, it } from 'vitest'
import { parseTranslatedPids } from './darwin-rosetta-processes'

describe('parseTranslatedPids', () => {
  it('reads ps flags as hex and keeps only rows with P_TRANSLATED (0x20000)', () => {
    // Read as decimal, 24004 has bit 0x20000 clear and pid 812 would be missed.
    const stdout = ['    1     4004', '  812    24004', '  813 40004004', '  814 1024084', ''].join(
      '\n'
    )
    expect(parseTranslatedPids(stdout)).toEqual([812, 814])
  })
})
