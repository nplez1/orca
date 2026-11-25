import { useAppStore } from '@/store'
import type { CloseTerminalDialogCopyKind } from '../../terminal-pane/layout/close/CloseTerminalDialog'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import { isPromptFreeAgentLaunchProcess } from '@/lib/agent-session/launch/new-tab/agent-tab-prompt-free-launch'
import type { PtyRunningWorkProbe } from '../../../../../shared/terminal/pty/lifecycle/pty-running-work-probe'
import { isNeverTaskedAgentSession } from './never-tasked-agent-session'

function leafPaneKey(tabId: string, leafId: string | null | undefined): string | null {
  if (!leafId || !isTerminalLeafId(leafId) || !tabId || tabId.includes(':')) {
    return null
  }
  return makePaneKey(tabId, leafId)
}

/** Share agent classification across pane- and PTY-scoped close prompts so identical closes use identical copy. */
export function resolveLeafCloseCopyKind(
  tabId: string,
  leafId: string | null | undefined
): CloseTerminalDialogCopyKind {
  // Legacy/mid-attach leaf IDs may fail makePaneKey; confirmation must not break close.
  if (!leafId || !isTerminalLeafId(leafId) || !tabId || tabId.includes(':')) {
    return 'command'
  }
  const agentStatusByPaneKey = useAppStore.getState().agentStatusByPaneKey
  const agentType = agentStatusByPaneKey.get(makePaneKey(tabId, leafId))?.agentType
  return agentType && agentType !== 'unknown' ? 'agent' : 'command'
}

export function isProbeOfEmptyAgentSession(
  tabId: string,
  probe: Pick<PtyRunningWorkProbe, 'ptyId' | 'verdict' | 'timedOut'>,
  leafId?: string | null
): boolean {
  try {
    if (probe.verdict !== 'live' || probe.timedOut) {
      return false
    }
    const state = useAppStore.getState()
    const ptyIdsByLeafId = state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}
    const leafIds = Object.entries(ptyIdsByLeafId)
      .filter(([candidate, ptyId]) => ptyId === probe.ptyId && (!leafId || candidate === leafId))
      .map(([candidate]) => candidate)
    return (
      leafIds.length > 0 &&
      leafIds.every((candidate) => {
        const paneKey = leafPaneKey(tabId, candidate)
        return (
          paneKey !== null &&
          isNeverTaskedAgentSession({
            entry: state.agentStatusByPaneKey.get(paneKey),
            launchedPromptFree: isPromptFreeAgentLaunchProcess(tabId, candidate, probe.ptyId),
            lastUserInputAt: state.lastTerminalInputAtByPaneKey[paneKey]
          })
        )
      })
    )
  } catch {
    return false
  }
}

/** Agent copy wins mixed splits because stopping an agent mid-task is the costlier surprise. */
export function resolveBusyPtyCloseCopyKind(
  tabId: string,
  busyPtyIds: readonly string[]
): CloseTerminalDialogCopyKind {
  const ptyIdsByLeafId =
    useAppStore.getState().terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (busyPtyIds.includes(ptyId) && resolveLeafCloseCopyKind(tabId, leafId) === 'agent') {
      return 'agent'
    }
  }
  return 'command'
}
