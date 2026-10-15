import { describe, expect, it } from 'vitest'
import {
  applyPiRemoteViewerTerminalClipboardEnv,
  PI_REMOTE_VIEWER_CLIPBOARD_ENV
} from './pi-terminal-clipboard'

describe('applyPiRemoteViewerTerminalClipboardEnv', () => {
  it('asks a Pi launch on a host the viewer is not sitting at for OSC 52 copies', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      isPiLaunch: true,
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBe('1')
  })

  it('leaves a local Pi launch alone', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      isPiLaunch: true,
      viewerIsRemote: false,
      inheritedEnv: {}
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })

  it('leaves a bare shell alone on a remote viewer', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      isPiLaunch: false,
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })

  it('never overrides an explicit opt-out the launch already carries', () => {
    const env: Record<string, string> = { [PI_REMOTE_VIEWER_CLIPBOARD_ENV]: '0' }
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      isPiLaunch: true,
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBe('0')
  })

  it('never overrides an inherited value', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      isPiLaunch: true,
      viewerIsRemote: true,
      inheritedEnv: { [PI_REMOTE_VIEWER_CLIPBOARD_ENV]: '0' }
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })
})
