// Which execution hosts a session summary can be built for, shared by the pane
// (which picks its empty state) and main (which decides whether to fold at all).
//
// Every known host kind can produce a brief: a paired Orca server folds its own
// sessions (`sessionSummary.openOnHost`), and an SSH target's transcript is fetched
// over the connection the desktop holds. Only an id this build cannot parse is
// unsupported — a newer host kind it must not guess about.
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from './execution-host'

export function isSessionSummaryHostSupported(hostId: string | null | undefined): boolean {
  const requested = hostId?.trim()
  if (!requested || requested === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  return parseExecutionHostId(requested) !== null
}
