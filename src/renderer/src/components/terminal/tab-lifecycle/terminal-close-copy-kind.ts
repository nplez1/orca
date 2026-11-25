import { useAppStore } from '@/store'
import type { CloseTerminalDialogCopyKind } from '../../terminal-pane/layout/close/CloseTerminalDialog'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import { wasAgentTabLaunchedPromptFree } from '@/lib/agent-session/launch/new-tab/agent-tab-prompt-free-launch'
import { isNeverTaskedAgentSession } from './never-tasked-agent-session'

// Legacy/mid-attach leaf IDs may fail makePaneKey; confirmation must not break close.
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
  const paneKey = leafPaneKey(tabId, leafId)
  if (!paneKey) {
    return 'command'
  }
  const agentType = useAppStore.getState().agentStatusByPaneKey.get(paneKey)?.agentType
  return agentType && agentType !== 'unknown' ? 'agent' : 'command'
}

/** One emptiness verdict for tab and pane closes, so the two prompts cannot drift (#95). */
export function isLeafAgentSessionEmpty(tabId: string, leafId: string | null | undefined): boolean {
  try {
    const paneKey = leafPaneKey(tabId, leafId)
    if (!paneKey) {
      return false
    }
    const state = useAppStore.getState()
    return isNeverTaskedAgentSession({
      entry: state.agentStatusByPaneKey.get(paneKey),
      launchedPromptFree: wasAgentTabLaunchedPromptFree(tabId),
      lastUserInputAt: state.lastTerminalInputAtByPaneKey[paneKey]
    })
  } catch {
    // The guard's catch closes silently; a failed lookup must ask instead.
    return false
  }
}

/** Live PTYs whose only work is a never-tasked agent: closing them stops nothing. */
export function isPtyEmptyAgentSession(tabId: string, ptyId: string): boolean {
  const ptyIdsByLeafId =
    useAppStore.getState().terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}
  const leafIds = Object.entries(ptyIdsByLeafId)
    .filter(([, leafPtyId]) => leafPtyId === ptyId)
    .map(([leafId]) => leafId)
  return leafIds.length > 0 && leafIds.every((leafId) => isLeafAgentSessionEmpty(tabId, leafId))
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
