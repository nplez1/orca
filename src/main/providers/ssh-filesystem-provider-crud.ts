import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { FileStat } from './types'

/** Thin relay-backed filesystem reads and mutations shared by the SSH provider surface. */
export abstract class SshFilesystemProviderCrud {
  constructor(protected readonly mux: SshChannelMultiplexer) {}

  async readDir(dirPath: string): Promise<DirEntry[]> {
    return (await this.mux.request('fs.readDir', { dirPath })) as DirEntry[]
  }

  async stat(filePath: string): Promise<FileStat> {
    return (await this.mux.request('fs.stat', { filePath })) as FileStat
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.mux.request('fs.writeFile', { filePath, content })
  }

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    await this.mux.request('fs.deletePath', { targetPath, recursive })
  }

  async createFile(filePath: string): Promise<void> {
    await this.mux.request('fs.createFile', { filePath })
  }

  async createDir(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDir', { dirPath })
  }

  async createDirNoClobber(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDirNoClobber', { dirPath })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.mux.request('fs.rename', { oldPath, newPath })
  }

  async renameNoClobber(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.mux.request('fs.renameNoClobber', { oldPath, newPath })
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        // Why: falling back to raw fs.rename can silently clobber the target on
        // older relays. Fail closed and let reconnect deploy the safe relay.
        throw new Error('Remote safe rename is unavailable. Reconnect the SSH target and retry.')
      }
      throw err
    }
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.mux.request('fs.copy', { source, destination })
  }

  async realpath(filePath: string): Promise<string> {
    return (await this.mux.request('fs.realpath', { filePath })) as string
  }

  async search(opts: SearchOptions): Promise<SearchResult> {
    return (await this.mux.request('fs.search', opts)) as SearchResult
  }
}
