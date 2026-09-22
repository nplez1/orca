import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOsOpenedDocuments } from './os-opened-documents'

vi.mock('../ipc/floating-workspace-directory', () => ({
  ensureFloatingWorkspaceDirectory: vi.fn()
}))

vi.mock('../ipc/filesystem-auth', () => ({
  authorizeExternalPath: vi.fn()
}))

const { ensureFloatingWorkspaceDirectory } = await import('../ipc/floating-workspace-directory')
const { authorizeExternalPath } = await import('../ipc/filesystem-auth')

describe('resolveOsOpenedDocuments', () => {
  let floatingRoot: string
  let fileRoot: string

  beforeEach(async () => {
    vi.mocked(ensureFloatingWorkspaceDirectory).mockClear()
    vi.mocked(authorizeExternalPath).mockClear()
    floatingRoot = await mkdtemp(join(tmpdir(), 'orca-os-open-root-'))
    fileRoot = await mkdtemp(join(tmpdir(), 'orca-os-open-files-'))
    vi.mocked(ensureFloatingWorkspaceDirectory).mockResolvedValue(floatingRoot)
  })

  afterEach(async () => {
    await rm(floatingRoot, { recursive: true, force: true })
    await rm(fileRoot, { recursive: true, force: true })
  })

  it.each(['md', 'csv', 'tsv'])(
    'resolves a real %s file outside the floating root',
    async (extension) => {
      const basename = `design notes.${extension}`
      const filePath = join(fileRoot, basename)
      await writeFile(filePath, '# hi\n', 'utf8')

      const documents = await resolveOsOpenedDocuments([filePath])

      expect(documents).toEqual([
        {
          filePath,
          relativePath: basename,
          basename,
          name: 'design notes'
        }
      ])
      expect(authorizeExternalPath).toHaveBeenCalledWith(filePath)
    }
  )

  it('drops unsupported or relative files even when they exist', async () => {
    const filePath = join(fileRoot, 'private.txt')
    await writeFile(filePath, 'private')
    expect(await resolveOsOpenedDocuments([filePath, 'relative.csv', 'file:///%zz.tsv'])).toEqual(
      []
    )
    expect(ensureFloatingWorkspaceDirectory).not.toHaveBeenCalled()
  })

  it('drops a directory that merely looks like a markdown file', async () => {
    const bundlePath = join(fileRoot, 'bundle.tsv')
    await mkdir(bundlePath)
    const filePath = join(fileRoot, 'real.md')
    await writeFile(filePath, '# hi\n', 'utf8')

    const documents = await resolveOsOpenedDocuments([bundlePath, filePath])

    expect(documents.map((document) => document.filePath)).toEqual([filePath])
    // Security contract: a path we never validated must never be authorized for renderer reads.
    expect(authorizeExternalPath).toHaveBeenCalledTimes(1)
    expect(authorizeExternalPath).toHaveBeenCalledWith(filePath)
  })

  it('drops a path that no longer exists', async () => {
    const missingPath = join(fileRoot, 'gone.csv')

    expect(await resolveOsOpenedDocuments([missingPath])).toEqual([])
    expect(authorizeExternalPath).not.toHaveBeenCalled()
  })

  it('returns nothing for an empty input without touching the filesystem', async () => {
    expect(await resolveOsOpenedDocuments([])).toEqual([])
    expect(ensureFloatingWorkspaceDirectory).not.toHaveBeenCalled()
  })
})
