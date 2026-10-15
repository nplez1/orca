import { describe, expect, it } from 'vitest'
import {
  applyPiRemoteViewerTerminalClipboardEnv,
  PI_REMOTE_VIEWER_CLIPBOARD_ENV
} from './pi-terminal-clipboard'

describe('applyPiRemoteViewerTerminalClipboardEnv', () => {
  it('asks a pane on a host the viewer is not sitting at for OSC 52 copies', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, { viewerIsRemote: true, inheritedEnv: {} })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBe('1')
  })

  it('leaves a pane alone when nobody views this host from elsewhere', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, { viewerIsRemote: false, inheritedEnv: {} })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })

  it('never overrides an explicit opt-out the launch already carries', () => {
    const env: Record<string, string> = { [PI_REMOTE_VIEWER_CLIPBOARD_ENV]: '0' }
    applyPiRemoteViewerTerminalClipboardEnv(env, { viewerIsRemote: true, inheritedEnv: {} })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBe('0')
  })

  it('never overrides an inherited opt-out', () => {
    const env: Record<string, string> = {}
    applyPiRemoteViewerTerminalClipboardEnv(env, {
      viewerIsRemote: true,
      inheritedEnv: { [PI_REMOTE_VIEWER_CLIPBOARD_ENV]: '0' }
    })
    expect(env[PI_REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })
})
