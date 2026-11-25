// The reader's questions about a session, in their own file beside the summary cache (#280).
//
// Why not in `session-summaries.json`: that file is a rebuildable cache — a version bump or a bad
// read discards it, and every process serving it rewrites the whole file. Questions are the reader's
// own words and a paid answer, so they live where only a process that records a question ever
// writes (a headless host never does), and where a ledger version bump cannot reach them. A build
// that predates this file ignores it, so a downgrade and upgrade keep them too.
//
// Asynchronous on purpose: it runs on the main thread, and a submit must not wait on an fsync.
// The cost is that a quit inside a write's few milliseconds loses that one change; a question
// recorded but not yet answered then reads back as interrupted and retryable.
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../filesystem/durable-file-write'
import { recordSwallowedFailure } from '../observability/swallowed-failure'
import type { SessionSummaryQuestion } from '../../shared/session-summary-types'
import {
  boundSessionSummaryQuestions,
  parseStoredSessionSummaryQuestions,
  SESSION_SUMMARY_QUESTION_FILE_MAX_BYTES,
  SESSION_SUMMARY_QUESTION_PANES_MAX,
  type SessionSummaryQuestionsEntry
} from './session-summary-question-records'
import { sessionSummaryIdentityChanged } from './session-summary-session-ref'

const QUESTION_STORE_VERSION = 1

export class SessionSummaryQuestionStore {
  private entries: Record<string, SessionSummaryQuestionsEntry> = {}
  /** Panes deleted before the file was read, so the read does not bring them back. */
  private readonly deletedBeforeLoad = new Set<string>()
  private loaded = false
  private dirty = false
  private saveQueued = false
  private writing: Promise<void> = Promise.resolve()
  /** Settles once the file has been read; questions asked before then are merged with it. */
  readonly ready: Promise<void>

  constructor(private readonly filePath: string) {
    this.ready = this.load()
  }

  get(paneKey: string): SessionSummaryQuestionsEntry | null {
    return this.entries[paneKey] ?? null
  }

  set(paneKey: string, entry: SessionSummaryQuestionsEntry): void {
    this.deletedBeforeLoad.delete(paneKey)
    this.entries[paneKey] = { ...entry, questions: boundSessionSummaryQuestions(entry.questions) }
    this.evict(paneKey)
    this.scheduleSave()
  }

  /** Drops a pane's questions — only when a different conversation took the pane. */
  delete(paneKey: string): void {
    if (!this.loaded) {
      this.deletedBeforeLoad.add(paneKey)
    }
    if (!(paneKey in this.entries)) {
      return
    }
    delete this.entries[paneKey]
    this.scheduleSave()
  }

  /** Resolves once every change made so far is on disk. */
  async flush(): Promise<void> {
    await this.ready
    await this.writing
  }

  /** Oldest panes first, until both the pane count and the file size fit. */
  private evict(keep: string): void {
    const sizes = new Map(
      Object.entries(this.entries).map(([key, entry]) => [key, JSON.stringify(entry).length])
    )
    let total = [...sizes.values()].reduce((sum, size) => sum + size, 0)
    const oldestFirst = [...sizes.keys()]
      .filter((key) => key !== keep)
      .sort((a, b) => this.entries[a].updatedAt - this.entries[b].updatedAt)
    for (const key of oldestFirst) {
      if (
        sizes.size <= SESSION_SUMMARY_QUESTION_PANES_MAX &&
        total <= SESSION_SUMMARY_QUESTION_FILE_MAX_BYTES
      ) {
        return
      }
      total -= sizes.get(key) ?? 0
      sizes.delete(key)
      delete this.entries[key]
    }
  }

  private scheduleSave(): void {
    this.dirty = true
    if (!this.loaded || this.saveQueued) {
      return
    }
    this.saveQueued = true
    this.writing = this.writing.then(async () => {
      this.saveQueued = false
      if (this.dirty) {
        this.dirty = false
        await this.save()
      }
    })
  }

  private async load(): Promise<void> {
    let stored: Record<string, SessionSummaryQuestionsEntry> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      // Rows are validated one by one: a malformed row costs that row, never the file.
      stored =
        typeof parsed === 'object' && parsed !== null && 'entries' in parsed
          ? parseStoredSessionSummaryQuestions(parsed.entries)
          : {}
    } catch {
      // Missing or unreadable: nothing has been asked here yet.
    }
    for (const [paneKey, entry] of Object.entries(stored)) {
      if (this.deletedBeforeLoad.has(paneKey)) {
        continue
      }
      const current = this.entries[paneKey]
      this.entries[paneKey] = current ? mergeEntries(entry, current) : entry
    }
    this.deletedBeforeLoad.clear()
    this.loaded = true
    if (this.dirty) {
      this.scheduleSave()
    }
  }

  private async save(): Promise<void> {
    try {
      // Why skip a vanished directory: a profile removed under a running process must not be
      // recreated holding only this file.
      await stat(dirname(this.filePath))
    } catch {
      return
    }
    try {
      await writeFileDurable(
        durableWriteTempPath(this.filePath),
        this.filePath,
        JSON.stringify({ version: QUESTION_STORE_VERSION, entries: this.entries })
      )
    } catch (error) {
      recordSwallowedFailure('session-summary', error, 'failed to persist summary questions')
    }
  }
}

/**
 * A row asked before the file was read wins and the file's other rows are kept beside it — unless
 * the file's rows are about a different conversation, which the pane has since replaced.
 */
function mergeEntries(
  stored: SessionSummaryQuestionsEntry,
  current: SessionSummaryQuestionsEntry
): SessionSummaryQuestionsEntry {
  if (sessionSummaryIdentityChanged(stored.identity, current.identity)) {
    return current
  }
  const known = new Set(current.questions.map((question) => question.id))
  const questions: SessionSummaryQuestion[] = [
    ...stored.questions.filter((question) => !known.has(question.id)),
    ...current.questions
  ].sort((a, b) => a.askedAt - b.askedAt)
  return { ...current, questions: boundSessionSummaryQuestions(questions) }
}
