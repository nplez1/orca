import { withinSessionSearchDeadline } from '../../ai-vault-search/session-search-request-deadline'
import type { SessionSearchIndexerOptions } from '../../ai-vault-search/session-search-indexer-options'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { aiVaultScanLimit } from '../../../shared/ai-vault/scanning/ai-vault-session-depth'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { getSessionParseCacheEntry } from '../parse-cache/session-parse-cache-store'
import { unavailableSessionSearchStatus } from '../../../shared/ai-vault/search/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../../shared/ai-vault/search/ai-vault-search-contract'
import { SessionSearchInstance } from '../../ai-vault-search/session-search-instance'
import {
  sameSessionSearchRoots,
  type SessionSearchScanRoots
} from '../../ai-vault-search/session-search-scan-roots'
import { sessionSearchSqliteAvailable } from '../../ai-vault-search/session-search-sqlite-support'
import { unionScopedSessions } from '../session-list-results'
import type {
  AiVaultServiceRequest,
  AiVaultServiceResultValue,
  AiVaultServiceScanOptions,
  AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

type SearchOperation = Extract<
  AiVaultServiceRequest,
  { operation: 'searchSessions' | 'searchStatus' | 'searchReconcile' | 'searchClear' }
>

/**
 * Preview turns the metadata tier does not store, from the parse cache when it
 * still holds them.
 *
 * Previews are conversation text, so they are not part of the metadata tier; but
 * this process already keeps the last few thousand decoded sessions in memory
 * (and on disk between launches) for its own reuse, so reading them back is a map
 * lookup rather than a transcript read. A row whose entry has aged out renders
 * without previews until something opens that one session — reading it here
 * would put back the cost this whole path exists to remove.
 */
function withCachedPreviews(session: AiVaultSession): AiVaultSession {
  const cached = getSessionParseCacheEntry(session.filePath)?.session
  if (!cached || cached.previewMessages.length === 0) {
    return session
  }
  return {
    ...session,
    previewMessages: cached.previewMessages,
    ...(cached.previewMessagesTruncated ? { previewMessagesTruncated: true } : {}),
    ...(cached.lastUserPrompt ? { lastUserPrompt: cached.lastUserPrompt } : {})
  }
}

/**
 * The scanner-service child's half of session search.
 *
 * Why the child and not the parent: the transcript reader runs here, so the
 * index consumer has to as well — one process reads a transcript once and both
 * the session list and the index see that read. Main, the CLI and a remote
 * server never open the database; they ask over this protocol.
 */
export class SessionScannerServiceSearch {
  private transition = Promise.resolve()
  private applying = 0
  private enabled = false
  private instance: SessionSearchInstance | null = null
  private databasePath: string | null = null
  private roots: SessionSearchScanRoots | null = null

  constructor(private readonly resolveRoots?: SessionSearchIndexerOptions['resolveRoots']) {}

  apply(init: AiVaultSessionSearchInit): Promise<void> {
    // The metadata tier has no off switch: an installed search service is an enabled one.
    this.enabled = true
    this.applying++
    const operation = this.transition.then(() => this.applySettings(init))
    this.transition = operation
      .catch((error: unknown) => console.warn('[ai-vault-search]', error))
      .finally(() => {
        this.applying--
      })
    return this.transition
  }

  private async applySettings(init: AiVaultSessionSearchInit): Promise<void> {
    if (!sessionSearchSqliteAvailable()) {
      return
    }
    if (this.instance && this.databasePath !== init.databasePath) {
      await this.closeInstance()
    }
    if (this.instance && this.roots && !sameSessionSearchRoots(this.roots, init.roots)) {
      // Refresh fallback roots for callers without a resolver.
      await this.closeInstance()
    }
    this.databasePath = init.databasePath
    this.roots = init.roots
    this.instance ??= new SessionSearchInstance({
      databasePath: init.databasePath,
      roots: init.roots,
      resolveRoots: this.resolveRoots
    })
    await this.instance.apply(init.settings)
  }

  handles(request: AiVaultServiceRequest): request is SearchOperation {
    return (
      request.operation === 'searchSessions' ||
      request.operation === 'searchStatus' ||
      request.operation === 'searchReconcile' ||
      request.operation === 'searchClear'
    )
  }

  async execute(
    request: SearchOperation,
    signal?: AbortSignal
  ): Promise<AiVaultServiceResultValue> {
    const instance = this.instance
    if (request.operation === 'searchStatus') {
      return {
        operation: 'searchStatus',
        value: this.enabled
          ? { ...((await instance?.status()) ?? unavailableSessionSearchStatus()), enabled: true }
          : unavailableSessionSearchStatus()
      }
    }
    if (request.operation === 'searchReconcile') {
      await withinSessionSearchDeadline(
        this.transition.then(() => this.instance?.reconcile(signal)),
        signal
      )
      return { operation: 'searchReconcile', value: null }
    }
    if (request.operation === 'searchClear') {
      if (!instance && !this.applying) {
        throw new Error('Agent Session History search is not available.')
      }
      await withinSessionSearchDeadline(
        this.transition.then(() => this.instance?.clear(signal)),
        signal
      )
      return { operation: 'searchClear', value: null }
    }
    return {
      operation: 'searchSessions',
      value: !this.enabled
        ? { kind: 'unavailable', reason: 'disabled' }
        : this.applying || !instance
          ? { kind: 'unavailable', reason: 'not-ready' }
          : await instance.search(
              AiVaultSearchRequestSchema.parse(request.request),
              request.hostScope,
              signal
            )
    }
  }

  /**
   * This host's session list from the index, or null when the caller must fall
   * back to the scanner (no index here, or none has finished a pass yet).
   *
   * `refresh` runs a bounded recent pass first. Once the list is served from the
   * index that is what a forced refresh has to mean — a session that just
   * started, or the refresh control — and the pass reads only transcripts whose
   * stat moved, so it is cheap in the common case and capped by the pass
   * deadline in the worst one. A refused reconciliation is a stale list, not a
   * failed read, which is why it is swallowed.
   */
  async listSessions(
    options: AiVaultServiceScanOptions,
    refresh: boolean,
    query?: string
  ): Promise<AiVaultListResult | null> {
    const instance = this.instance
    if (!instance) {
      return null
    }
    if (refresh) {
      await instance.reconcile().catch(() => undefined)
    }
    const limit = aiVaultScanLimit(options)
    const scopePaths = options.scopePaths ?? []
    const read = (paths: readonly string[]): AiVaultSession[] | null =>
      instance.listSessions({
        limit,
        scopePaths: paths,
        executionHostId: options.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
        ...(query ? { query } : {})
      })?.sessions ?? null
    // The unscoped page comes first: a scope widens it, never replaces it, and an
    // unbounded page already holds every scope's rows.
    const unbounded = !Number.isFinite(limit)
    const capped = read([])
    if (capped === null) {
      return null
    }
    // The union the scanner applies. The second read shares the first's turn, so a null
    // here cannot differ from it.
    const scopeSessions = scopePaths.length > 0 && !unbounded ? (read(scopePaths) ?? []) : []
    const sessions = unionScopedSessions(capped, scopeSessions)
    return {
      sessions: sessions.map(withCachedPreviews),
      issues: [],
      scannedAt: new Date().toISOString()
    }
  }

  close(): Promise<void> {
    return (this.transition = this.transition.then(() => this.closeInstance()))
  }

  private async closeInstance(): Promise<void> {
    const retired = this.instance?.close()
    this.instance = null
    this.databasePath = null
    this.roots = null
    await retired
  }

  /** Drop index rows the caller has proven gone, so a delete is not a ghost row
   *  until the next pass happens to notice the file is missing. */
  forgetSources(paths: readonly string[]): void {
    this.instance?.forgetSources(paths)
  }
}
