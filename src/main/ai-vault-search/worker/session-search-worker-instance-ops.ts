import type SyncDatabase from '../../sqlite/sync-database'
import { listIndexedSessions, type IndexedSessionList } from '../session-search-list'
import {
  SessionSearchStore,
  writeSessionSearchContentConsent
} from '../storage/session-search-store'
import type { SearchWorkerCommand } from './session-search-worker-protocol'

// The SQL SessionSearchInstance needs, run on the worker: the instance lives on orcad's event loop.

/** Open the writer store and record the instance's consent before any reader opens the index. */
export function openWriterStore(
  command: Extract<SearchWorkerCommand, { op: 'open' }>,
  onError: (error: unknown) => never,
  onMessagesChanged: (delta: number) => void
): SessionSearchStore {
  const store = new SessionSearchStore(
    command.path,
    onError,
    onMessagesChanged,
    command.contentEnabled
  )
  if (command.contentEnabled !== undefined) {
    // Readers read the tier from the rows, not the setting.
    writeSessionSearchContentConsent(store.connection, command.contentEnabled)
  }
  return store
}

/** Every requested page in this one worker turn. */
export function listSessionPages(
  reader: SyncDatabase | null,
  command: Extract<SearchWorkerCommand, { op: 'list' }>
): IndexedSessionList[] {
  if (!reader) {
    throw new Error('Search reader is not open')
  }
  return command.lists.map((args) => listIndexedSessions(reader, args))
}
