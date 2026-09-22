/** Copilot background work that can outlive the foreground turn. */
export type CopilotBackgroundWorkState = {
  pendingShellCount: number
  /** Agent tool starts not yet associated with a SubagentStart lifecycle hook. */
  pendingUnidentifiedSubagentCount: number
  pendingSubagentLifecycleCount: number
  leadStopped: boolean
}
