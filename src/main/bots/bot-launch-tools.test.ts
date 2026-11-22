import { describe, expect, it } from 'vitest'
import { BotLaunchTools, withBotLaunchToolsEnv } from './bot-launch-tools'

const relayedTools = () =>
  BotLaunchTools.for(
    { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 't' }) },
    { botId: 'b', folder: '/b', agent: 'claude' },
    [{ name: 'docs', url: 'https://docs.example/mcp', credential: 'cred-docs-1' }]
  )

describe("a bot launch's environment", () => {
  it('lets the CLI reach the relay directly behind a proxy, keeping the bypasses it had', async () => {
    const relayed = await relayedTools()
    const env = withBotLaunchToolsEnv(
      {
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: 'corp.example, localhost',
        no_proxy: '.internal'
      },
      relayed
    )
    expect(env.NO_PROXY).toBe('corp.example,localhost,.internal,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.ORCA_BOT_TOOLS_TOKEN).toBe('t')
  })
})

describe("a bot's token", () => {
  it('reaches every bot launch, tools or none: Claude in its env, Codex only in its commands’', async () => {
    const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 't' }) }
    const claude = await BotLaunchTools.for(
      relay,
      { botId: 'b', name: 'Scout', folder: '/b', agent: 'claude' },
      []
    )
    const codex = await BotLaunchTools.for(
      relay,
      { botId: 'b', name: 'Scout', folder: '/b', agent: 'codex' },
      []
    )
    expect(withBotLaunchToolsEnv({}, claude).ORCA_BOT_TOOLS_TOKEN).toBe('t')
    expect(claude.commandEnv).toEqual({})
    expect(withBotLaunchToolsEnv({}, codex).ORCA_BOT_TOOLS_TOKEN).toBeUndefined()
    expect(codex.commandEnv).toEqual({ ORCA_BOT_TOOLS_TOKEN: 't' })
  })

  it.skipIf(process.platform === 'win32')(
    "puts the bot's own gh first on PATH, in both agents' own environment",
    async () => {
      const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 't' }) }
      const claude = await BotLaunchTools.for(
        relay,
        { botId: 'b', name: 'Scout', folder: '/b', agent: 'claude' },
        []
      )
      const codex = await BotLaunchTools.for(
        relay,
        { botId: 'b', name: 'Scout', folder: '/b', agent: 'codex' },
        []
      )

      const claudeEnv = withBotLaunchToolsEnv({}, claude)
      expect(claudeEnv.PATH?.split(':')[0]).toContain('.gh-shims')
      expect(claudeEnv).not.toHaveProperty('ORCA_BOT_GH_SHIM_DIR')
      expect(withBotLaunchToolsEnv({}, codex).PATH?.split(':')[0]).toContain('.gh-shims')
    }
  )

  it('installs no shim for a launch that cannot name its bot, rather than marking with another', async () => {
    const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 't' }) }
    const probe = await BotLaunchTools.for(relay, { botId: 'b', folder: '/b', agent: 'claude' }, [])

    expect(withBotLaunchToolsEnv({}, probe)).not.toHaveProperty('PATH')
  })
})
