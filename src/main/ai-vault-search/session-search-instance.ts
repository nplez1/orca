import { withinSessionSearchDeadline } from './session-search-request-deadline'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault/search/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault/search/ai-vault-search-client'
import type { AiVaultSearchSettings } from '../../shared/ai-vault/search/ai-vault-search-settings'
import { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchReaders } from './session-search-readers'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'
import type SyncDatabase from '../sqlite/sync-database'
import {
  removeSessionSearchDatabaseAsync,
  openSessionSearchDatabase
} from './session-search-schema'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import type { SessionSearchHostScope } from './session-search-service'
import {
  listIndexedSessions,
  type IndexedSessionList,
  type IndexedSessionListArgs
} from './session-search-list'
import { writeSessionSearchContentConsent } from './session-search-store'

export type SessionSearchInstanceOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  onError?: (error: unknown) => void
  reconcileIntervalMs?: number
}
type LiveIndex = {
  indexer: SessionSearchIndexer
  readers: SessionSearchReaders
  /** Reader connection for the index list; the indexer owns a separate writer connection. */
  db: SyncDatabase
}

/** Replace the writer and readers together, awaiting their exits before reopening or unlinking. */
export class SessionSearchInstance {
  private live: LiveIndex | null = null
  private settings: AiVaultSearchSettings = { contentEnabled: false, historyDays: null }
  private transition: Promise<void> | null = null
  /** An index has been configured for this host; only closing keeps it from having one. */
  private applied = false
  private readonly onError: (error: unknown) => void
  constructor(private readonly options: SessionSearchInstanceOptions) {
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
  }
  get running(): boolean {
    return this.live !== null
  }
  apply(next: AiVaultSearchSettings): Promise<void> {
    this.settings = next
    this.applied = true
    return this.queue(next, false).catch(() => undefined)
  }
  clear(signal?: AbortSignal): Promise<void> {
    return withinSessionSearchDeadline(this.queue(this.settings, true), signal)
  }
  close(): Promise<void> {
    return this.trackTransition((this.transition ?? Promise.resolve()).then(() => this.closeLive()))
  }
  private trackTransition(operation: Promise<void>): Promise<void> {
    const pending = operation.catch(this.onError).finally(() => {
      if (this.transition === pending) {
        this.transition = null
      }
    })
    this.transition = pending
    return pending
  }
  private queue(settings: AiVaultSearchSettings, clear: boolean): Promise<void> {
    const old = this.live
    this.live = null
    old?.indexer.close()
    old?.db.close()
    const retired = old
      ? Promise.all([old.indexer.retired(), old.readers.close()])
      : Promise.resolve()
    const operation = (this.transition ?? Promise.resolve()).then(async () => {
      await retired
      await this.closeLive()
      if (clear) {
        await removeSessionSearchDatabaseAsync(this.options.databasePath)
      }
      // Open before the writer does: the writer's process reads consent from the
      // rows, so the record has to land before the indexer's store opens.
      const db = openSessionSearchDatabase(this.options.databasePath)
      writeSessionSearchContentConsent(db, settings.contentEnabled)
      try {
        const indexer = new SessionSearchIndexer({
          ...this.options,
          historyDays: settings.historyDays,
          contentEnabled: settings.contentEnabled
        })
        try {
          await indexer.initialize()
        } catch (error) {
          indexer.close()
          await indexer.retired()
          throw error
        }
        const readers = new SessionSearchReaders(
          this.options.databasePath,
          sessionSearchHistoryCutoffMs(settings.historyDays, Date.now())
        )
        this.live = { indexer, readers, db }
        void indexer.start().catch(this.onError)
      } catch (error) {
        db.close()
        throw error
      }
    })
    this.trackTransition(operation)
    return operation
  }
  async search(
    request: AiVaultSearchRequest,
    scope?: SessionSearchHostScope,
    signal?: AbortSignal
  ): Promise<AiVaultSearchResponse> {
    const live = this.live
    if (!live) {
      // Consent and readiness are the host's, not the scope's — and the metadata
      // tier is always on wherever an index can exist, so an absent instance is a
      // host that cannot hold one or one still constructing, never a consent
      // decision.
      return { kind: 'unavailable', reason: 'not-ready' }
    }
    const response = await live.readers.query(request, scope, signal)
    if (!response.result) {
      throw new Error('Could not search sessions')
    }
    return response.result
  }
  async status(): Promise<AiVaultSearchStatus> {
    const live = this.live
    if (!live) {
      return {
        ...unavailableSessionSearchStatus(),
        enabled: this.applied,
        ...(this.applied && this.transition ? { phase: 'indexing', messagesIndexed: 0 } : {})
      }
    }
    return {
      enabled: true,
      contentEnabled: this.settings.contentEnabled,
      ...live.indexer.status(),
      generation: live.indexer.generation()
    }
  }
  reconcile(signal?: AbortSignal): Promise<void> {
    return withinSessionSearchDeadline(
      (this.transition ?? Promise.resolve()).then(() =>
        this.live?.indexer.reconcile({ full: true })
      ),
      signal
    )
  }

  /**
   * Agent Session History's list, from the metadata tier, or null when this host
   * cannot answer from it yet.
   *
   * Null is the warm-up rule: an index that has never completed a pass must not
   * render as an empty history, so the caller falls back to the scanner until one
   * has. The gate is the completed sweep and not `filesIndexed > 0`, because a
   * host with no sessions never indexes a file and would otherwise be stranded on
   * the scanner for good.
   */
  listSessions(args: IndexedSessionListArgs): IndexedSessionList | null {
    const live = this.live
    if (!live || live.indexer.status().lastSweepCompletedAt === null) {
      return null
    }
    return listIndexedSessions(live.db, args)
  }

  /**
   * Drop sources the caller has proven gone. A delete must not appear to have
   * failed until the next pass notices the file is missing.
   */
  forgetSources(paths: readonly string[]): void {
    this.live?.indexer.forgetSources(paths)
  }

  /** Tests only: resolves once the work loop has no pass in flight. */
  async settled(): Promise<void> {
    await this.transition
    await this.live?.indexer.settled()
  }
  private async closeLive(): Promise<void> {
    const live = this.live
    this.live = null
    if (!live) {
      return
    }
    live.indexer.close()
    live.db.close()
    await Promise.all([live.indexer.retired(), live.readers.close()])
  }
}
