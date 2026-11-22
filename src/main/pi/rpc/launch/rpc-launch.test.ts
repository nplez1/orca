import { describe, expect, it } from 'vitest'
import { buildPiRpcLaunch, piToolLimit } from './rpc-launch'

const options = { command: 'host-resolved-pi', cwd: '/host/folder', fullAccess: true }
describe('Pi RPC launch for bots', () => {
  it('appends standing instructions from a file and loads linked skill folders', () => {
    expect(
      buildPiRpcLaunch({
        ...options,
        instructionsFile: '/data/acp-instructions/chat.md',
        skillDirs: ['/bots/one/skills']
      }).args
    ).toEqual([
      '--mode',
      'rpc',
      '--append-system-prompt',
      '/data/acp-instructions/chat.md',
      '--skill',
      '/bots/one/skills'
    ])
  })

  it('refuses a read run that names no gate, so bash cannot be offered ungated', () => {
    expect(() => buildPiRpcLaunch({ ...options, tools: 'read' })).toThrow(
      'A limited Pi run needs its read-only gate'
    )
  })

  it('limits a reply-only run, resumed sessions included', () => {
    expect(
      buildPiRpcLaunch({ ...options, tools: 'none', sessionFile: '/host/session.jsonl' }).args
    ).toEqual(['--mode', 'rpc', '--no-tools', '--no-mcp', '--session', '/host/session.jsonl'])
  })

  it('loads the read-only gate beside a look run, resumed sessions included', () => {
    expect(
      buildPiRpcLaunch({
        ...options,
        tools: 'read',
        readOnlyGate: { extension: '/host/pi-native-chat/orca-look-around-gate.ts' },
        sessionFile: '/host/session.jsonl'
      }).args
    ).toEqual([
      '--mode',
      'rpc',
      '--tools',
      'read,grep,find,ls,bash',
      '--no-mcp',
      '--extension',
      '/host/pi-native-chat/orca-look-around-gate.ts',
      '--session',
      '/host/session.jsonl'
    ])
  })

  it.each([['--tools', 'bash'], ['-t=bash'], ['--exclude-tools', 'edit']])(
    'refuses a tool selection of its own on a limited run: %j',
    (...extraArgs) => {
      expect(() =>
        buildPiRpcLaunch({
          ...options,
          tools: 'read',
          readOnlyGate: { extension: '/host/gate.ts' },
          extraArgs
        })
      ).toThrow('conflicts with a limited tool launch')
      expect(() =>
        buildPiRpcLaunch({ ...options, tools: 'none', prefixArgs: ['/pi/cli.js', ...extraArgs] })
      ).toThrow('conflicts with a limited tool launch')
    }
  )

  it('limits a run only on a Pi that can also turn MCP off', () => {
    const ready = (version: string) => ({ status: 'ready' as const, version })
    expect(piToolLimit('look-around', ready('1.5.0'))).toBe('read')
    expect(piToolLimit('reply-only', ready('1.0.4'))).toBe('none')
    expect(piToolLimit(null, ready('0.90.0'))).toBeNull()
    expect(() => piToolLimit('look-around', ready('1.0.3'))).toThrow()
  })
})
