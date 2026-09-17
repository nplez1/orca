import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import type { RemoteSessionContent } from './remote-session-content-lines'
import type { RemoteScannerContext, RemoteSessionSource } from './remote-session-scanner-types'
import { parseCopilotSessionContent } from './session-scanner-copilot-parser'
import type { FileWithMtime } from './session-scanner-types'

/**
 * Copilot keeps one directory per session at `<root>/<uuid>/events.jsonl`, beside
 * artifact trees (`files/`, `research/`, `checkpoints/`) that hold no sessions, so
 * only the session directories themselves are walked.
 */
export function remoteCopilotSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  const parse = (
    file: FileWithMtime,
    content: RemoteSessionContent,
    context: RemoteScannerContext
  ) =>
    parseCopilotSessionContent(
      file,
      content,
      context.hostPlatform.os,
      {
        executionHostId: context.executionHostId,
        executionHostPlatform: context.hostPlatform.os
      },
      context.signal
    )
  return {
    agent: 'copilot',
    rootDir: joinRemotePath(hostPlatform, remoteHome, '.copilot', 'session-state'),
    extensions: ['.jsonl'],
    directoryPredicate: (_name, depth) => depth === 0,
    parse,
    parseLines: parse
  }
}
