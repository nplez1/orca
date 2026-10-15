/**
 * Pi-family CLIs copy to the clipboard of the machine they run on and only *additionally* write
 * OSC 52 when they believe a remote client is watching — an `SSH_*`/`MOSH_*` marker, or this var.
 * An agent Orca launched on a paired server carries no SSH marker, and a server with a clipboard of
 * its own (a second Mac) makes that local copy succeed, so nothing reaches the machine the user is
 * sitting at: they paste whatever they had copied before. Pi documents the var for exactly this
 * shape — "a remote client reaches Pi without SSH variables ... or a remote IDE daemon".
 *
 * Sibling of `codex-terminal-clipboard.ts`, which fakes `SSH_CONNECTION` for the same reason
 * (#23530). A separate file because this knob belongs to the CLI and not to a faked SSH session:
 * only a launch identified as Pi-family is stamped, so no other program changes its behaviour.
 */
export const PI_REMOTE_VIEWER_CLIPBOARD_ENV = 'PI_CLIPBOARD_OSC52'

export function applyPiRemoteViewerTerminalClipboardEnv(
  env: Record<string, string>,
  options: {
    /** True only for a positively identified Pi-family launch (typed agent, or its own command). */
    isPiLaunch: boolean
    viewerIsRemote: boolean
    inheritedEnv?: NodeJS.ProcessEnv
  }
): void {
  if (!options.isPiLaunch || !options.viewerIsRemote) {
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
