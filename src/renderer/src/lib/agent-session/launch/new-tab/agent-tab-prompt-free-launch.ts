import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupSettings } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import {
  AUTO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS
} from '../../../../../../shared/agent-launch/permissions/tui-agent-permissions'

/**
 * Session-only: the one PTY this window spawned for a tab launched with no prompt, draft, args or
 * command override. It vouches for that process alone; a respawn, resume, wake or moved pane in the
 * same tab is a different process. Absence (reload, eviction, other launch paths) means unknown.
 */

const MAX_REMEMBERED_LAUNCHES = 256
type PromptFreeLaunch = { leafId: string; ptyId: string } | 'awaiting-spawn'
const launchesByTabId = new Map<string, PromptFreeLaunch>()

/** Resume/continue flags and wrapper commands live in args and overrides the status row cannot see. */
export function isPromptFreeAgentTabLaunch(
  launch: { agent: TuiAgent; prompt?: string; agentArgs?: string | null; actionAgentArgs?: string },
  settings: Pick<AgentStartupSettings, 'agentDefaultArgs' | 'agentCmdOverrides'> | null | undefined
): boolean {
  const effectiveArgs = (
    launch.actionAgentArgs ??
    (launch.agentArgs === undefined ? settings?.agentDefaultArgs?.[launch.agent] : launch.agentArgs)
  )?.trim()
  // Settings' Yolo/Auto presets write exactly these flags; they change approvals, not the conversation.
  const permissionPresetOnly =
    effectiveArgs === YOLO_TUI_AGENT_ARGS[launch.agent] ||
    effectiveArgs === AUTO_TUI_AGENT_ARGS[launch.agent]
  return (
    !launch.prompt?.trim() &&
    (!effectiveArgs || permissionPresetOnly) &&
    !settings?.agentCmdOverrides?.[launch.agent]?.trim()
  )
}

export function notePromptFreeAgentTabLaunch(tabId: string): void {
  launchesByTabId.delete(tabId)
  launchesByTabId.set(tabId, 'awaiting-spawn')
  for (const oldest of launchesByTabId.keys()) {
    if (launchesByTabId.size <= MAX_REMEMBERED_LAUNCHES) {
      break
    }
    launchesByTabId.delete(oldest)
  }
}

/** Only the queued startup's own first spawn binds; later spawns in the tab stay unknown. */
export function bindPromptFreeAgentTabLaunch(tabId: string, leafId: string, ptyId: string): void {
  if (launchesByTabId.get(tabId) === 'awaiting-spawn') {
    launchesByTabId.set(tabId, { leafId, ptyId })
  }
}

export function forgetPromptFreeAgentTabLaunch(tabId: string): void {
  launchesByTabId.delete(tabId)
}

export function isPromptFreeAgentLaunchProcess(
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  const launch = launchesByTabId.get(tabId)
  return typeof launch === 'object' && launch.leafId === leafId && launch.ptyId === ptyId
}
