import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  downloadRuntimeFile: vi.fn(),
  openFilePath: vi.fn(),
  revealInFileManager: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/runtime-file-client', () => ({
  downloadRuntimeFile: mocks.downloadRuntimeFile
}))

import {
  downloadAndOpenRemoteTerminalFile,
  downloadAndRevealRemoteTerminalFile
} from './terminal-remote-file-download-open'

const runtimeContext: RuntimeFileOperationArgs = {
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

const sshContext: RuntimeFileOperationArgs = {
  ...runtimeContext,
  connectionId: 'ssh-1'
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      fs: { downloadFile: mocks.downloadFile },
      shell: { openFilePath: mocks.openFilePath, openInFileManager: mocks.revealInFileManager }
    }
  })
  vi.clearAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe('remote terminal file download', () => {
  it('reveals the saved copy instead of launching it', async () => {
    mocks.downloadRuntimeFile.mockResolvedValue({ canceled: false, destinationPath: '/Users/me/x' })

    await downloadAndRevealRemoteTerminalFile(runtimeContext, '/repo/docs/report.html')

    // Why the flag: an active runtime environment must not make main refuse a path the save
    // dialog just produced on this client.
    expect(mocks.revealInFileManager).toHaveBeenCalledWith('/Users/me/x', { clientLocalPath: true })
    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })

  it('still opens the saved copy for the default-app row', async () => {
    mocks.downloadFile.mockResolvedValue({ canceled: false, destinationPath: '/Users/me/x' })

    await downloadAndOpenRemoteTerminalFile(sshContext, '/repo/docs/report.html')

    expect(mocks.downloadFile).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      filePath: '/repo/docs/report.html'
    })
    expect(mocks.openFilePath).toHaveBeenCalledWith('/Users/me/x')
    expect(mocks.revealInFileManager).not.toHaveBeenCalled()
  })

  it('leaves a cancelled save dialog as a no-op', async () => {
    mocks.downloadRuntimeFile.mockResolvedValue({ canceled: true })

    await downloadAndRevealRemoteTerminalFile(runtimeContext, '/repo/docs/report.html')

    expect(mocks.revealInFileManager).not.toHaveBeenCalled()
    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('surfaces a failed transfer instead of revealing a path that was never saved', async () => {
    mocks.downloadRuntimeFile.mockRejectedValue(new Error('relay closed'))

    await downloadAndRevealRemoteTerminalFile(runtimeContext, '/repo/docs/report.html')

    expect(mocks.toastError).toHaveBeenCalledWith('relay closed')
    expect(mocks.revealInFileManager).not.toHaveBeenCalled()
  })
})
