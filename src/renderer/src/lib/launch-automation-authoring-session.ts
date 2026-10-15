/**
 * Opens the authoring conversation.
 *
 * The session is a normal agent session in the workspace the automation is being
 * authored for — the same tab path Quick Launch uses, with the same agent the user
 * picked — because the point of authoring conversationally is that it can be read,
 * answered and steered. Orca's only contribution is the brief it starts with.
 */

import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'

export type LaunchAutomationAuthoringSessionInput = {
  agent: TuiAgent
  worktreeId: string
  brief: string
  /** Set for an edit session, so the tab is named after the automation. */
  automationName?: string | null
}

/** True when the session opened; false when the workspace or agent is not usable. */
export function launchAutomationAuthoringSession(
  input: LaunchAutomationAuthoringSessionInput
): boolean {
  const state = useAppStore.getState()
  const executionHostId = getExecutionHostIdForWorktree(state, input.worktreeId)
  const worktree = state.getKnownWorktreeById(input.worktreeId, executionHostId)
  if (!worktree || !isTuiAgentEnabled(input.agent, state.settings?.disabledTuiAgents)) {
    return false
  }
  state.setActiveWorktree(input.worktreeId, executionHostId)
  return (
    launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: input.agent,
      worktreeId: input.worktreeId,
      prompt: input.brief,
      // Submitted once the agent's composer is ready: the brief is long, and a draft
      // the user has to press Enter on would read as Orca doing nothing.
      promptDelivery: 'submit-after-ready',
      launchSource: 'unknown',
      ...(input.automationName ? { quickCommandLabel: input.automationName } : {})
    }) !== null
  )
}
