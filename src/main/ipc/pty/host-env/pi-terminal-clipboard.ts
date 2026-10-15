/**
 * Pi-family CLIs copy to the clipboard of the machine they run on and only *additionally* write
 * OSC 52 when they believe a remote client is watching — an `SSH_*`/`MOSH_*` marker, or this var.
 * An agent Orca launched on a paired server carries no SSH marker, and a server with a clipboard of
 * its own (a second Mac) makes that local copy succeed, so nothing reaches the machine the user is
 * sitting at: they paste whatever they had copied before. Pi documents the var for exactly this
 * shape — "a remote client reaches Pi without SSH variables ... or a remote IDE daemon".
 *
 * Every pane of such a host is stamped, not only an identified agent launch: the CLI is often
 * started by hand inside a shell, and only Pi-family CLIs read this key, so nothing else changes
 * behaviour. An inherited value still wins, so `PI_CLIPBOARD_OSC52=0` stays a global opt-out.
 *
 * Sibling of `codex-terminal-clipboard.ts`, which fakes `SSH_CONNECTION` for the same reason
 * (#23530) but is scoped to Codex launches: a faked SSH session changes more than the clipboard.
 */
export const PI_REMOTE_VIEWER_CLIPBOARD_ENV = 'PI_CLIPBOARD_OSC52'

export function applyPiRemoteViewerTerminalClipboardEnv(
  env: Record<string, string>,
  options: {
    viewerIsRemote: boolean
    inheritedEnv?: NodeJS.ProcessEnv
  }
): void {
  if (!options.viewerIsRemote) {
    return
  }
  const inherited = options.inheritedEnv ?? process.env
  // Why respect an existing value: an explicit `0` is the user's opt-out, and `1` is already on —
  // including one inherited from the launching environment, which overrides no built value.
  if (
    env[PI_REMOTE_VIEWER_CLIPBOARD_ENV] !== undefined ||
    inherited[PI_REMOTE_VIEWER_CLIPBOARD_ENV] !== undefined
  ) {
    return
  }
  env[PI_REMOTE_VIEWER_CLIPBOARD_ENV] = '1'
}
