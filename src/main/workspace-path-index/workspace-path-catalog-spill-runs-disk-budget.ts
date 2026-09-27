import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const SPILL_DISK_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

/** Recursive directory size, short-circuited once the spill disk budget is exceeded. */
export async function directorySizeBytes(directory: string): Promise<number> {
  let size = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      size += await directorySizeBytes(entryPath)
    } else if (entry.isFile()) {
      size += (await stat(entryPath)).size
    }
    if (size > SPILL_DISK_BUDGET_BYTES) {
      return size
    }
  }
  return size
}

export async function isWithinDiskBudget(directory: string): Promise<boolean> {
  return (await directorySizeBytes(directory)) <= SPILL_DISK_BUDGET_BYTES
}
