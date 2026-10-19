/** The restart watch's "is this pane still working" answer, emitted inside the extension factory
 *  because only that scope sees the roster and the runtime (`agent-status-handler-source.ts` is at
 *  the file-length cap). The watch, and its timer, live in the post queue. */
export function getPiAgentStatusRestartWatchSourceLines(): string[] {
  return [
    '  // Why: this fork folds the async child roster receiver-side, so the lead DOES post its own',
    '  // `agent_end` while those children work. The pane still reads working, so a restart can still',
    '  // silently invalidate it, and the watch stays armed until nothing holds the row open.',
    '  postQueue.watchStillWorking = function () {',
    '    if (isHeldByChildren()) return true',
    '    if (isOmpRuntime()) return false',
    "    // Why: only the pi lane binds the fork's roster; `typeof` is safe on a name it never declares.",
    '    const runs =',
    '      typeof piAsyncSubagentField === "function" ? piAsyncSubagentField().subagent_runs : undefined',
    '    return Array.isArray(runs) && runs.length > 0',
    '  }',
    ''
  ]
}
