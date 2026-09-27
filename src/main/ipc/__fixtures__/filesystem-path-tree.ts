import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_FILESYSTEM_PATH_TREE_FILE_COUNT = 25_000
export const MAX_FILESYSTEM_PATH_TREE_FILE_COUNT = 100_000
const DIRECTORY_BUCKET_COUNT = 256
const FILE_WRITE_BATCH_SIZE = 256

export type FilesystemPathTreeFixture = {
  rootPath: string
  relativePaths: readonly string[]
  cleanup(): Promise<void>
}

/** Materializes a deterministic, portable tree outside the repository for real traversal tests. */
export async function createFilesystemPathTreeFixture(
  fileCount = DEFAULT_FILESYSTEM_PATH_TREE_FILE_COUNT
): Promise<FilesystemPathTreeFixture> {
  if (
    !Number.isSafeInteger(fileCount) ||
    fileCount < 0 ||
    fileCount > MAX_FILESYSTEM_PATH_TREE_FILE_COUNT
  ) {
    throw new RangeError(
      `Filesystem fixture count must be between 0 and ${MAX_FILESYSTEM_PATH_TREE_FILE_COUNT}`
    )
  }

  const rootPath = await mkdtemp(join(tmpdir(), 'orca-path-tree-'))
  const relativePaths = Array.from({ length: fileCount }, (_, index) => {
    const bucket = (index % DIRECTORY_BUCKET_COUNT).toString(36).padStart(2, '0')
    const file = index.toString(36).padStart(7, '0')
    return `src/bucket-${bucket}/path-${file}.ts`
  })
  const directories = new Set(
    relativePaths.map((relativePath) => dirname(join(rootPath, relativePath)))
  )

  try {
    await Promise.all([...directories].map((directory) => mkdir(directory, { recursive: true })))
    for (let offset = 0; offset < relativePaths.length; offset += FILE_WRITE_BATCH_SIZE) {
      const batch = relativePaths.slice(offset, offset + FILE_WRITE_BATCH_SIZE)
      await Promise.all(
        batch.map((relativePath) => writeFile(join(rootPath, relativePath), '', { flag: 'wx' }))
      )
    }
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true })
    throw error
  }

  let isCleaned = false
  return {
    rootPath,
    relativePaths,
    async cleanup() {
      if (!isCleaned) {
        isCleaned = true
        await rm(rootPath, { recursive: true, force: true })
      }
    }
  }
}
