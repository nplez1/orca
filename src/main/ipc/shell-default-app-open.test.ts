import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { handleMock, openPathMock, realpathMock, showItemInFolderMock, statMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(),
    openPathMock: vi.fn(),
    realpathMock: vi.fn<(path: string) => Promise<string>>(),
    showItemInFolderMock: vi.fn(),
    statMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  shell: { showItemInFolder: showItemInFolderMock, openExternal: vi.fn(), openPath: openPathMock },
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('node:fs/promises', () => ({
  constants: { COPYFILE_EXCL: 1 },
  copyFile: vi.fn(),
  realpath: realpathMock,
  stat: statMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCliCommand: (command: string) => command
}))

import { registerShellHandlers } from './shell'
import { resolveDefaultAppOpenTarget } from './shell-owned-path-target'

const store = { getSshTarget: () => undefined }

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  registerShellHandlers(store as never)
  const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>
}

function fileStats(mode: number): { isFile: () => boolean; mode: number } {
  return { isFile: () => true, mode }
}

beforeEach(() => {
  handleMock.mockReset()
  openPathMock.mockReset()
  realpathMock.mockReset()
  realpathMock.mockImplementation(async (path: string) => path)
  showItemInFolderMock.mockReset()
  statMock.mockReset()
  openPathMock.mockResolvedValue('')
})

describe('resolveDefaultAppOpenTarget', () => {
  it('refuses the file kinds `shell.openPath` would execute', async () => {
    // Why: on macOS these run in Terminal or launch a bundle, and a cloned repo keeps whatever a
    // README links to — Git preserves the executable bit and adds no quarantine flag. The mode is a
    // plain document's, so each case fails on the name alone.
    for (const name of [
      'docs/guide.command',
      'dist/setup.exe',
      'run.ps1',
      'deploy.bat',
      'shortcut.lnk',
      'app.desktop',
      'notes.terminal',
      'deploy.tool',
      'installer.msi',
      'payload.jar'
    ]) {
      statMock.mockResolvedValueOnce(fileStats(0o644))
      await expect(resolveDefaultAppOpenTarget(resolve(name))).resolves.toEqual({
        ok: false,
        reason: 'executable-target'
      })
    }
  })

  it('refuses an app bundle, and a symlink that points at one', async () => {
    // The bundle is a directory, and a link's own name carries no extension, so both are refusals the
    // extension list only reaches through `realpath`.
    statMock.mockResolvedValueOnce({ isFile: () => false, mode: 0o755 })
    await expect(resolveDefaultAppOpenTarget(resolve('Payload.app'))).resolves.toEqual({
      ok: false,
      reason: 'executable-target'
    })

    realpathMock.mockResolvedValueOnce(resolve('Payload.app'))
    statMock.mockResolvedValueOnce({ isFile: () => false, mode: 0o755 })
    await expect(resolveDefaultAppOpenTarget(resolve('docs/guide'))).resolves.toEqual({
      ok: false,
      reason: 'executable-target'
    })
  })

  it('sees through the trailing dots Win32 strips when it opens a file', async () => {
    // `evil.exe.` runs `evil.exe`; `extname('evil.exe.')` is `.` alone.
    statMock.mockResolvedValueOnce(fileStats(0o644))

    await expect(resolveDefaultAppOpenTarget(resolve('evil.exe.'))).resolves.toEqual({
      ok: false,
      reason: 'executable-target'
    })
  })

  it('refuses a document that carries the executable bit', async () => {
    // An extensionless or .md file launched by shebang is the same execution without a tell in the
    // name, so the mode is checked as well.
    for (const name of ['docs/guide.md', 'build/tool']) {
      statMock.mockResolvedValueOnce(fileStats(0o755))
      await expect(resolveDefaultAppOpenTarget(resolve(name))).resolves.toEqual({
        ok: false,
        reason: 'executable-target'
      })
    }
  })

  it('resolves an ordinary document', async () => {
    statMock.mockResolvedValueOnce(fileStats(0o644))
    const filePath = resolve('docs/guide.md')

    await expect(resolveDefaultAppOpenTarget(filePath)).resolves.toEqual({
      ok: true,
      path: normalize(filePath)
    })
  })

  it('does not treat a plain directory as an executable launch target', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => false, mode: 0o755 })

    await expect(resolveDefaultAppOpenTarget(resolve('scripts'))).resolves.toMatchObject({
      ok: true
    })
  })

  it('keeps the existing absolute-and-exists checks', async () => {
    await expect(resolveDefaultAppOpenTarget('relative/guide.md')).resolves.toEqual({
      ok: false,
      reason: 'not-absolute'
    })
    statMock.mockRejectedValueOnce(new Error('missing'))
    await expect(resolveDefaultAppOpenTarget(resolve('missing.md'))).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
  })
})

describe('shell handlers that reach the OS default app', () => {
  it('refuses an executable path from shell:openFilePath', async () => {
    statMock.mockResolvedValueOnce(fileStats(0o644))

    await expect(
      getHandler('shell:openFilePath')({}, resolve('docs/guide.command'), 'local')
    ).resolves.toBe(false)
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('refuses an executable file URI from a markdown link', async () => {
    // Cmd+Shift+click on `[docs](./docs/guide.command)`: no line number means no editor route, so
    // the link arrives here and the OS would run it.
    statMock.mockResolvedValueOnce(fileStats(0o644))
    const uri = pathToFileURL(resolve('docs/guide.command')).toString()

    await expect(getHandler('shell:openFileUri')({}, uri, 'local')).resolves.toBeUndefined()
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('still opens a document through both handlers', async () => {
    const filePath = resolve('docs/guide.md')
    statMock.mockResolvedValue(fileStats(0o644))

    await expect(getHandler('shell:openFilePath')({}, filePath, 'local')).resolves.toBe(true)
    await expect(
      getHandler('shell:openFileUri')({}, pathToFileURL(filePath).toString(), 'local')
    ).resolves.toBeUndefined()
    expect(openPathMock).toHaveBeenCalledTimes(2)
  })
})
