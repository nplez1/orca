import type { SessionSearchIndexerOptions } from '../ai-vault-search/session-search-indexer-options'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultScanLimit } from '../../shared/ai-vault-session-depth'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import { SessionSearchInstance } from '../ai-vault-search/session-search-instance'
import {
  sameSessionSearchRoots,
  type SessionSearchScanRoots
} from '../ai-vault-search/session-search-scan-roots'
import { sessionSearchSqliteAvailable } from '../ai-vault-search/session-search-sqlite-support'
import type {
  AiVaultServiceRequest,
  AiVaultServiceResultValue,
  AiVaultSessionSearchInit
} from './session-scanner-service-protocol'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'

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
  private instance: SessionSearchInstance | null = null
  private databasePath: string | null = null
  private roots: SessionSearchScanRoots | null = null

  constructor(private readonly resolveRoots?: SessionSearchIndexerOptions['resolveRoots']) {}

  /** Applied at init and again on every settings change; both are close-and-construct. */
  apply(init: AiVaultSessionSearchInit): void {
    if (!sessionSearchSqliteAvailable()) {
      return
    }
    if (this.instance && this.databasePath !== init.databasePath) {
      // A data root cannot move under a running process, so this is a caller bug
      // rather than a case to support: close the old one before it writes there.
      this.close()
    }
    if (this.instance && this.roots && !sameSessionSearchRoots(this.roots, init.roots)) {
      // Explicit init-root changes replace the fallback used by callers without a resolver.
      this.close()
    }
    this.databasePath = init.databasePath
    this.roots = init.roots
    this.instance ??= new SessionSearchInstance({
      databasePath: init.databasePath,
      roots: init.roots,
      resolveRoots: this.resolveRoots
    })
    this.instance.apply(init.settings)
  }

  handles(request: AiVaultServiceRequest): request is SearchOperation {
    return (
      request.operation === 'searchSessions' ||
      request.operation === 'searchStatus' ||
      request.operation === 'searchReconcile' ||
      request.operation === 'searchClear'
    )
  }

  async execute(request: SearchOperation): Promise<AiVaultServiceResultValue> {
    const instance = this.instance
    if (request.operation === 'searchStatus') {
      return {
        operation: 'searchStatus',
        value: instance?.status() ?? unavailableSessionSearchStatus()
      }
    }
    if (request.operation === 'searchReconcile') {
      await instance?.reconcile()
      return { operation: 'searchReconcile', value: null }
    }
    if (request.operation === 'searchClear') {
      if (!instance) {
        throw new Error('Agent Session History search is not available.')
      }
      instance.clear()
      return { operation: 'searchClear', value: null }
    }
    return {
      operation: 'searchSessions',
      value: instance
        ? await instance.search(
            AiVaultSearchRequestSchema.parse(request.request),
            request.hostScope
          )
        : { kind: 'unavailable', reason: 'not-ready' }
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
    options: AiVaultWorkerScanOptions,
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
    const listed = instance.listSessions({
      limit: aiVaultScanLimit(options),
      scopePaths: options.scopePaths ?? [],
      executionHostId: options.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
      ...(query ? { query } : {})
    })
    return listed === null
      ? null
      : {
          sessions: listed.sessions.map(withCachedPreviews),
          issues: [],
          scannedAt: new Date().toISOString()
        }
  }

  close(): void {
    this.instance?.close()
    this.instance = null
    this.databasePath = null
    this.roots = null
  }

  /** Drop index rows the caller has proven gone, so a delete is not a ghost row
   *  until the next pass happens to notice the file is missing. */
  forgetSources(paths: readonly string[]): void {
    this.instance?.forgetSources(paths)
  }
}
