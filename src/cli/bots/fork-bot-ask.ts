// `orca bot ask`: ask a bot on this computer a question from the owner's own shell. It is the mail
// path, so the bot knows who asked, and the answer comes back to the terminal that asked.
import type { Bot } from '../../shared/bot-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { isDevCliInvocation } from '../orchestration/recovery/runtime-compatibility'
import { resolveOrchestrationTerminalHandle } from '../orchestration/identity/terminal-identity'
import { callBots, type BotsListResult } from './bot'

/** `--chat new` starts a chat for the ask; every other value names one of the bot's chats. */
export const BOT_ASK_NEW_CHAT = 'new'

const SUBJECT_MAX_LENGTH = 80

/** The subject a human ask goes without: the ask's own first line, cut to a subject's length. */
export function askSubject(body: string | undefined, given: string | undefined): string {
  const said = given?.trim()
  if (said) {
    return said
  }
  const first = (body ?? '').trim().split('\n')[0]?.trim() ?? ''
  const chars = Array.from(first)
  return chars.length > SUBJECT_MAX_LENGTH
    ? `${chars
        .slice(0, SUBJECT_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`
    : first || 'A question'
}

/** The one bot a selector names, by id or name; a name two bots hold refuses instead of guessing. */
export function botOfSelector(
  bots: readonly Pick<Bot, 'id' | 'name'>[],
  selector: string
): Pick<Bot, 'id' | 'name'> {
  const name = selector.trim().toLowerCase()
  const matches = bots.filter((bot) => bot.id === selector || bot.name.toLowerCase() === name)
  const [only] = matches
  if (!only) {
    const named = bots.map((bot) => bot.name)
    throw new RuntimeClientError(
      'bot_not_found',
      named.length === 0
        ? `There is no bot named ${selector}: this computer has none.`
        : `There is no bot named ${selector} on this computer. Its bots: ${named.join(', ')}.`
    )
  }
  if (matches.length > 1) {
    throw new RuntimeClientError(
      'ambiguous_bot',
      `${matches.map((bot) => bot.name).join(', ')} both answer to ${selector}; pass the id of the one you mean.`
    )
  }
  return only
}

/** The chat the ask lands in, refused unless that chat takes mail now. */
export function botAskChat(
  chat: string | undefined,
  chats: readonly BotChatRow[]
): string | undefined {
  if (!chat || chat === BOT_ASK_NEW_CHAT) {
    return chat
  }
  const found = chats.find((row) => row.id === chat)
  if (!found) {
    throw new RuntimeClientError(
      'chat_not_found',
      `This bot has no chat ${chat}. \`orca bot chats --bot <name>\` lists the ones that take mail.`
    )
  }
  if (found.closed) {
    throw new RuntimeClientError(
      'chat_closed',
      `Chat ${chat} takes no mail now (${found.reason ?? 'closed'}). Ask in another chat, or add --chat ${BOT_ASK_NEW_CHAT}.`
    )
  }
  return chat
}

/** The terminal this ask comes from, so its answer has somewhere to go. Only a terminal Orca started
 *  can be that: inferring one from the working folder would let an ask typed in any shell speak as a
 *  sibling pane, take its mail, and be answered into its agent. */
async function askerTerminal(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  if (!process.env.ORCA_TERMINAL_HANDLE) {
    return undefined
  }
  try {
    return await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from', {
      validateEnvHandle: true
    })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'no_active_sender_terminal') {
      return undefined
    }
    throw error
  }
}

type AskReceipt = { message?: { id: string } }

export const BOT_ASK_HANDLERS: Record<string, CommandHandler> = {
  'bot ask': async ({ flags, client, cwd, json }) => {
    const bot = botOfSelector(
      (await callBots<BotsListResult>(client, 'bots.list')).result.bots,
      getRequiredStringFlag(flags, 'bot')
    )
    const body = await readTextOrFileFlag(flags, cwd, 'body', true)
    const chat = getOptionalStringFlag(flags, 'chat')
    if (chat && chat !== BOT_ASK_NEW_CHAT) {
      const chats = await callBots<{ chats: BotChatRow[] }>(client, 'bots.chats', {
        botId: bot.id
      })
      botAskChat(chat, chats.result.chats)
    }
    const subject = askSubject(body, getOptionalStringFlag(flags, 'subject'))
    // The id, not the name: two bots may differ only in case, and the address matches by name.
    const from = await askerTerminal(flags, cwd, client)
    const result = await client.call<AskReceipt>('orchestration.send', {
      to: `bot:${bot.id}`,
      ...(from ? { from } : {}),
      ...(chat ? { chat } : {}),
      subject,
      body,
      type: 'question',
      devMode: isDevCliInvocation()
    })
    printResult(result, json, () =>
      from
        ? `Asked ${bot.name}; its answer comes back here: orca orchestration check --terminal ${from}`
        : `Asked ${bot.name} in its chat; its answer lands there.`
    )
  }
}
