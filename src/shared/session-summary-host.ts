// Which execution hosts a session summary can be built for, shared by the pane
// (which picks its empty state) and main (which decides whether to fold at all).
//
// Both halves of a summary are pinned to this machine: the fold brain spawns the
// local agent CLI, so a remote session needs its transcript fetched here. Every
// known host kind is fetchable — SSH over the connection the desktop holds, a paired
// Orca server over `sessionSummary.readTranscript` — so only an id this build cannot
// parse is unsupported, which is a newer host kind it must not guess about.
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from './execution-host'

export function isSessionSummaryHostSupported(hostId: string | null | undefined): boolean {
  const requested = hostId?.trim()
  if (!requested || requested === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  return parseExecutionHostId(requested) !== null
}
