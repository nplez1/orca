import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'

// Moved out of session-search-schema.ts (upstream's home for it) so SessionSearchInstance, which
// orcad loads in process, can unlink the index without importing the opener's synchronous SQL.

/** Async lock retries keep scanner/server deadlines responsive after all workers have retired. */
export async function removeSessionSearchDatabaseAsync(path: string): Promise<void> {
  if (path === ':memory:') {
    return
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await removeTree(`${path}${suffix}`)
  }
}
