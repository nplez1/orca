/** Pi's opt-in to also emit OSC 52 after its own clipboard write.
 *
 *  Why: pi copies with the host's clipboard command and emits OSC 52 only when it believes
 *  nobody local is watching (SSH_CONNECTION, SSH_CLIENT, MOSH_CONNECTION, this flag) or when no
 *  clipboard command worked at all (headless Linux). A pi session on an Orca host watched from a
 *  paired client matches none of those, so its copy landed on the HOST's clipboard while pi
 *  reported "Copied". Orca's terminal consumes OSC 52 in whichever client renders the pane, so
 *  setting this in every PTY environment routes the copy to the reader's clipboard, additive to
 *  the local write.
 *
 *  Why not the SSH_CONNECTION stand-in Codex gets (host-env/codex-terminal-clipboard.ts): Codex
 *  has no flag of its own, and that helper only covers an Orca-launched agent on a runtime whose
 *  viewer is already known to be remote — which misses a desktop server that also has a paired
 *  client. Pi's flag means nothing else, so it is safe in every pane. */
export const PI_CLIPBOARD_OSC52_ENV = 'PI_CLIPBOARD_OSC52'
export const PI_CLIPBOARD_OSC52_VALUE = '1'
