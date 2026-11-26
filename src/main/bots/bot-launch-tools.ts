// A bot's tools as its agent CLI gets them: a tool with saved headers becomes Orca's relay address plus
// the bot's token, so no saved value reaches the CLI's argv, env or config. The token also names the
// bot to the runtime for its Google commands.
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import type { BotToolsCli } from './bot-tools-host'
import {
  botToolRelay,
  MCP_HOST_LIST_RELAY_OWNER,
  type BotToolRelay
} from './tool-relay/bot-tool-relay'
import { SessionMcpTools, withSessionMcpToolsEnv } from '../mcp-servers/session-mcp-tools'
import { botHostMcpAccess } from '../mcp-servers/bot-host-mcp-access'
import { sharedMcpProcessIds } from '../mcp-servers/mcp-shared-process-servers'
import { BOT_TOOLS_TOKEN_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { botGhShimEnv, withBotGhShimOnPath } from './fork-gh-shim'
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/** A bot's servers ready for its CLI; only `BotLaunchTools.for` makes one, so no saved value slips through. */
export class BotLaunchTools {
  static readonly none = new BotLaunchTools([], {}, {}, false, false)
  // A private member makes the type nominal: a plain object with the same fields isn't one.
  declare private readonly nominal: true

  private constructor(
    readonly servers: readonly BotToolServer[],
    /** Added to the CLI's environment. */
    readonly env: Readonly<Record<string, string>>,
    /** Added to the environment of the commands the CLI runs, not the CLI's own. */
    readonly commandEnv: Readonly<Record<string, string>>,
    /** Some tool goes through the relay, so the CLI must reach loopback directly. */
    readonly relayed: boolean,
    private readonly commandsOnly: boolean
  ) {}

  /**
   * Every bot launch gets the bot's token, whichever agent runs it: tools present it to the relay,
   * and the `orca` calls the session makes to the runtime, which names the bot by it.
   */
  static async for(
    relay: Pick<BotToolRelay, 'grant'>,
    bot: { botId: string; folder: string; agent: string; name?: string },
    servers: readonly BotToolServer[]
  ): Promise<BotLaunchTools> {
    if (servers.some((server) => 'url' in server && Object.keys(server.headers ?? {}).length > 0)) {
      // Header values live in the credential store; one here was never migrated, so it never launches.
      throw new BotFailureError('toolValuesUnmoved')
    }
    const { origin, token } = await relay.grant(bot.botId, { bot: bot.folder })
    const tokenEnv = { [BOT_TOOLS_TOKEN_ENV]: token }
    const shimEnv = await botGhShimEnv({ id: bot.botId, ...(bot.name ? { name: bot.name } : {}) })
    // Claude and Pi expand `${VAR}` in a server's headers, so their config names only the variable.
    const authorization = ENV_REFERENCING_AGENTS.has(bot.agent)
      ? `Bearer \${${BOT_TOOLS_TOKEN_ENV}}`
      : `Bearer ${token}`
    // Codex saves its own env into shell snapshots on disk, so only the commands it runs get the token.
    const commandsOnly = bot.agent === 'codex'
    return new BotLaunchTools(
      servers.map((server): BotToolServer => {
        if (!('url' in server) || !server.credential) {
          return server
        }
        return {
          name: server.name,
          url: `${origin}/bot-tools/${server.credential}/mcp`,
          transport: 'http',
          headers: { authorization }
        }
      }),
      commandsOnly ? shimEnv : { ...tokenEnv, ...shimEnv },
      commandsOnly ? tokenEnv : {},
      servers.some((server) => 'url' in server && server.credential),
      commandsOnly
    )
  }

  withGithubAppEnv(appEnv: Readonly<Record<string, string>>): BotLaunchTools {
    if (Object.keys(appEnv).length === 0) {
      return this
    }
    return this.commandsOnly
      ? new BotLaunchTools(
          this.servers,
          this.env,
          { ...this.commandEnv, ...appEnv },
          this.relayed,
          true
        )
      : new BotLaunchTools(
          this.servers,
          { ...this.env, ...appEnv },
          this.commandEnv,
          this.relayed,
          false
        )
  }

  // fork-comment-ok: why a launch env entry ignores the commandsOnly split is not readable from the code.
  /** A project bound to the GitHub App pushes as it, and a terminal's git is not the CLI's commands. */
  withGitCredentialEnv(gitEnv: Readonly<Record<string, string>>): BotLaunchTools {
    return Object.keys(gitEnv).length === 0
      ? this
      : new BotLaunchTools(
          this.servers,
          { ...this.env, ...gitEnv },
          this.commandEnv,
          this.relayed,
          this.commandsOnly
        )
  }
}

const ENV_REFERENCING_AGENTS: ReadonlySet<string> = new Set(['claude', 'pi'])

/** `env` with the tools' additions, and loopback added to both NO_PROXY spellings when needed. */
export function withBotLaunchToolsEnv(
  env: Record<string, string>,
  tools: BotLaunchTools
): Record<string, string> {
  const launchEnv = withBotGhShimOnPath({ ...env, ...tools.env })
  if (!tools.relayed) {
    return launchEnv
  }
  // Both CLIs send loopback calls into HTTP(S)_PROXY unless NO_PROXY names loopback.
  const existing = [launchEnv.NO_PROXY, launchEnv.no_proxy]
    .flatMap((value) => (value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
  const noProxy = [...new Set([...existing, ...LOOPBACK_HOSTS])].join(',')
  return { ...launchEnv, NO_PROXY: noProxy, no_proxy: noProxy }
}

/** The bot's servers as its CLI gets them for a turn, and the CLI with the env that goes with them. */
export async function cliWithLaunchTools(
  cli: BotToolsCli,
  servers: readonly BotToolServer[]
): Promise<{ cli: BotToolsCli; tools: SessionMcpTools }> {
  // The host list's checks run its servers as a non-bot session gets them, under the host's token.
  const tools =
    cli.botId === MCP_HOST_LIST_RELAY_OWNER
      ? await SessionMcpTools.for(
          botToolRelay,
          { bot: null, agent: cli.agent },
          // A shared server is checked through its one process, as sessions reach it.
          {
            host: {
              folder: cli.folder,
              servers,
              sharedProcesses: await sharedMcpProcessIds(cli.folder)
            }
          }
        )
      : await SessionMcpTools.for(
          botToolRelay,
          { bot: { botId: cli.botId, folder: cli.folder }, agent: cli.agent },
          // The bot's token is its running chats' too: a check keeps their reach to the host list.
          { own: servers, host: botHostMcpAccess(cli.hostMcpServers === true) }
        )
  return { cli: { ...cli, env: withSessionMcpToolsEnv(cli.env, tools) }, tools }
}

/** A relayed tool's server that refused its saved values says so on the row. */
export function withRelayProblems(
  cli: BotToolsCli,
  servers: readonly BotToolServer[],
  problems: Record<string, BotToolProblem>
): Record<string, BotToolProblem> {
  const out = { ...problems }
  for (const server of servers) {
    const detail =
      'url' in server && server.credential
        ? botToolRelay.lastProblem(cli.folder, server.credential)
        : null
    if (detail && out[server.name]) {
      out[server.name] = { kind: 'failed', detail }
    }
  }
  return out
}

/** A bot session's note that its own tools are off and `why`, so it doesn't claim or try them. */
export function botToolsOffInstruction(why: string): string {
  return `Your own tools (MCP servers) are off in this session: ${why}. Don't say you have them or try to use them.`
}
