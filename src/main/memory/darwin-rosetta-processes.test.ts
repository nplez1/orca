import { describe, expect, it } from 'vitest'
import { parseRosettaProcesses } from './darwin-rosetta-processes'

describe('parseRosettaProcesses', () => {
  it('keeps rows whose hex flags carry P_TRANSLATED (0x20000), with the full executed path', () => {
    // Read as decimal, 24004 has bit 0x20000 clear and pid 812 would be missed.
    const stdout = [
      '  812    24004 /usr/local/bin/workflowd',
      '  813 40004004 /bin/zsh',
      '  814  1024084 /Users/me/Intel Tools/old cli',
      ''
    ].join('\n')
    expect(parseRosettaProcesses(stdout)).toEqual([
      { pid: 812, executable: '/usr/local/bin/workflowd' },
      { pid: 814, executable: '/Users/me/Intel Tools/old cli' }
    ])
  })
})
