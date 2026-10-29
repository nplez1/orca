import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import { basename, dirname, extname } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorFoldResumeState,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionText } from './session-scanner-messages'
import {
  asRecord,
  copilotModelMetricsTotal,
  extractString,
  extractTrustedFolder,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseCopilotSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan', signal),
    crlfDelay: Infinity
  })
  return parseCopilotSessionLines({ file, lines, platform, messages })
}

function consumeCopilotRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const data = asRecord(record.data)
  if (record.type === 'session.start' && data) {
    const sessionId = extractString(data.sessionId)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    // Why: the session's representative cwd is its START directory (first-wins,
    // like updateLatestLocation). `context.cwd` is the authoritative field the
    // CLI records; a folder_trust message is only the legacy stand-in.
    accumulator.cwd ??= extractString(asRecord(data.context)?.cwd)
    updateTimeline(accumulator, extractString(data.startTime))
    // Folder-trust notices are optional; session.start records the launch directory.
    const context = asRecord(data.context)
    if (context) {
      accumulator.cwd ??= extractString(context.cwd) ?? extractString(context.gitRoot)
      accumulator.branch ??= extractString(context.branch)
    }
    return
  }
  if (record.type === 'session.model_change' && data) {
    accumulator.model = extractString(data.newModel) ?? accumulator.model
    return
  }
  if (record.type === 'session.info' && data) {
    // Why: never let a later trust message move the session to another folder —
    // that misattributes it to the wrong workspace and drops it from its own.
    accumulator.cwd ??= extractTrustedFolder(data.message)
    return
  }
  if (record.type === 'user.message' && data) {
    accumulator.messageCount++
    // Why: `content` is the prompt as typed; `transformedContent` is what the
    // model sees, and Copilot prefixes that with injected context such as
    // `<current_datetime>...</current_datetime>`. Prefer the typed prompt so
    // injected context never becomes the session title, preview, or first prompt.
    const userText = extractString(data.content) ?? extractString(data.transformedContent)
    accumulator.title ??= normalizeTitleText(userText ?? '')
    addSessionText(accumulator, { role: 'user', text: userText, timestamp: record.timestamp })
    return
  }
  if (record.type === 'assistant.message' && data) {
    accumulator.messageCount++
    addSessionText(accumulator, {
      role: 'assistant',
      text: extractString(data.content),
      timestamp: record.timestamp
    })
    return
  }
  if (record.type === 'session.shutdown' && data) {
    accumulator.model = extractString(data.currentModel) ?? accumulator.model
    accumulator.totalTokens += numberValue(data.currentTokens)
    accumulator.totalTokens += copilotModelMetricsTotal(data.modelMetrics)
  }
}

export function createCopilotSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({
      agent: 'copilot',
      file,
      sessionId: copilotSessionIdFromPath(file.path),
      messages
    }),
    consumeCopilotRecordLine
  )
}

/**
 * Copilot stores one directory per session — `<session-state>/<sessionId>/events.jsonl` — so the
 * file name is a constant and the directory is the identity. Falling back to the file name filed
 * every such session under the literal id `events`, i.e. one row for all of them.
 */
function copilotSessionIdFromPath(filePath: string): string {
  return basename(filePath, extname(filePath)) === 'events'
    ? basename(dirname(filePath))
    : sessionIdFromFileName(filePath)
}

async function parseCopilotSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createCopilotSessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
