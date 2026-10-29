import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { asRecord } from './session-scanner-record-value'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

export { asRecord }

/** ECMAScript Date range; `new Date(ms).toISOString()` throws beyond it. */
const MAX_DATE_MS = 8_640_000_000_000_000
/** Beyond this the value is a mis-scaled epoch or a broken clock, never a session time. */
const FUTURE_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * One timestamp from a transcript written by somebody else's agent.
 *
 * Why the bounds: a nanosecond epoch is ordinary format drift, and `new Date(1.7e18)` throws
 * `RangeError` inside the parse loop, which loses the whole session rather than one line. A
 * microsecond epoch is inside the Date range but lands in the year 55840, so it would pin its row
 * above every real session forever.
 *
 * Why an impossible value is dropped rather than clamped to now: the row would still sort to the
 * top, and the same line would decode to a different instant on every read. Dropped, the other
 * timestamps in the transcript — or the file's own mtime — decide the order. Numbers only: an ISO
 * string states which instant it means, and extended-year values like `+010000-01-01` are preserved.
 */
export function timestampMs(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  const parsed = value > 1_000_000_000_000 ? value : value * 1000
  if (parsed > MAX_DATE_MS || parsed > Date.now() + FUTURE_TIMESTAMP_SKEW_MS) {
    return Number.NaN
  }
  return parsed
}

/**
 * Session identity a transcript path carries. Pi-family names are
 * `<stamp>_<uuid>.jsonl` and the uuid is what the header repeats as `id`, so
 * this is how a lineage path resolves to the parent row's session id.
 */
export function sessionIdFromFileName(filePath: string): string {
  const fileName = basename(filePath, extname(filePath))
  const match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match?.[0] ?? fileName
}

/**
 * Byte-order mark a Windows editor leaves at the start of a file (Notepad, PowerShell's utf8).
 *
 * Why it needs stripping rather than trimming: U+FEFF counts as whitespace for `trim()` but not for
 * `JSON.parse`, so a BOM-prefixed first record both looks non-empty and fails to parse — that is
 * how a session loses its header and its workspace.
 */
const BYTE_ORDER_MARK = '\uFEFF'

function stripLeadingByteOrderMark(line: string): string {
  return line.startsWith(BYTE_ORDER_MARK) ? line.slice(BYTE_ORDER_MARK.length) : line
}

export function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = stripLeadingByteOrderMark(line).trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return asRecord(parsed)
  } catch {
    return null
  }
}

export function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function extractModel(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  return (
    extractString(record.model) ||
    extractString(record.model_name) ||
    extractString(asRecord(record.metadata)?.model) ||
    extractString(asRecord(record.info)?.model) ||
    null
  )
}

export {
  extractContentText,
  extractMessageText,
  extractPreviewContentText,
  normalizePreviewText,
  normalizeTitleText,
  sliceAtCodeUnitLimit
} from './session-scanner-text-normalization'
export {
  extractFullFirstUserPromptText,
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'

export function extractGitBranch(value: unknown): string | null {
  const git = asRecord(value)
  if (!git) {
    return null
  }
  return extractString(git.branch) || extractString(git.current_branch)
}

export async function readJsonObjectIfExists(
  filePath: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await wslGatedReadFile(filePath, 'utf-8', 'scan', signal))
    return asRecord(parsed)
  } catch (error) {
    // Propagate cancellation so it cannot be cached as absent enrichment.
    throwIfAiVaultScanCancelled(signal)
    // Propagate WSL refusal as an issue; caching null can prevent retries for unchanged files.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    // An oversized sidecar is enrichment this session can live without: the session still lists.
    return null
  }
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = extractString(record[key])
    if (value) {
      return value
    }
  }
  return null
}

export function extractTrustedFolder(value: unknown): string | null {
  const message = extractString(value)
  if (!message) {
    return null
  }
  return message.match(/^Folder (.+) has been added to trusted folders\.$/)?.[1] ?? null
}

export function timeObjectValue(value: unknown, key: string): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const rawValue = record[key]
  if (typeof rawValue === 'string') {
    return rawValue
  }
  const parsed = timestampMs(rawValue)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}

export function findOpenCodeStorageRoot(filePath: string): string | null {
  const sessionDir = dirname(filePath)
  const sessionRoot = dirname(sessionDir)
  if (basename(sessionRoot) !== 'session') {
    return null
  }
  return dirname(sessionRoot)
}

// Accept Pi/OMP home, agent, or sessions paths.
export function normalizeAgentSessionsDir(
  rawValue: string,
  agentHomeDirName: '.pi' | '.omp'
): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return join(homedir(), agentHomeDirName, 'agent', 'sessions')
  }
  const normalized = trimmed.replace(/[\\/]+$/, '')
  const leaf = basename(normalized)
  if (leaf === 'sessions') {
    return normalized
  }
  if (leaf === 'agent') {
    return join(normalized, 'sessions')
  }
  if (leaf === agentHomeDirName) {
    return join(normalized, 'agent', 'sessions')
  }
  return normalized
}

function defaultPrimeAgentSessionsDir(): string {
  return join(homedir(), '.prime', 'agent', 'sessions')
}

// Pi/Prime expand leading ~ themselves; other CLIs such as Grok treat it literally.
function absoluteConfiguredDir(rawValue: string): string | null {
  const expanded = rawValue === '~' ? homedir() : rawValue.replace(/^~(?=[\\/])/, homedir())
  const normalized = expanded.replace(/[\\/]+$/, '')
  return resolveAbsoluteDirOverride(normalized, '') || null
}

// Prime always appends sessions, even when the configured agent directory is named sessions.
export function normalizePrimeAgentSessionsDir(rawAgentDir: string): string {
  const agentDir = absoluteConfiguredDir(rawAgentDir.trim())
  return agentDir ? join(agentDir, 'sessions') : defaultPrimeAgentSessionsDir()
}

// Explicit session-root overrides outrank the agent directory and are used verbatim.
export function primeAgentSessionsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const sessionDir =
    env.PRIME_AGENT_SESSION_DIR?.trim() || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim()
  if (sessionDir) {
    return absoluteConfiguredDir(sessionDir) ?? defaultPrimeAgentSessionsDir()
  }
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR?.trim()
  return agentDir ? normalizePrimeAgentSessionsDir(agentDir) : defaultPrimeAgentSessionsDir()
}

export function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export {
  addCodexUsage,
  claudeUsageTotal,
  copilotModelMetricsTotal,
  normalizeCodexUsage,
  numberValue,
  subtractCodexUsage,
  tokenTotal
} from './session-scanner-token-values'
