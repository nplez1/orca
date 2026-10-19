import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  launchAgentInNewTab,
  shouldQueueTerminalFocusAfterMenuClose
} from '@/lib/launch-agent-in-new-tab'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type DefaultAgentLaunchContext = {
  worktreeId: string
  groupId: string
  /** Focus the local terminal the launch created. */
  onLocalTerminal: (tabId: string) => void
  /** Queue focus for a launch whose terminal arrives asynchronously from the host. */
  onHostTerminal: () => void
}

/**
 * Launches one agent from the split new-tab button.
 *
 * Why agent-level and not a menu row: the button has to work before the agent rows settle, and its
 * surface is the user's Chat UI setting. Going through a row would force `requestedSurface`, prefer
 * a chat row over the terminal one, and — on a host whose chat is unavailable — select a row the
 * launch helper refuses, so an installed agent would launch nothing.
 */
export function launchDefaultAgentInNewTab(
  agent: TuiAgent,
  context: DefaultAgentLaunchContext
): void {
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    focusIntent: captureNativeChatComposerFocusIntent(),
    agent,
    worktreeId: context.worktreeId,
    groupId: context.groupId,
    launchSource: 'tab_bar_quick_launch'
  })
  if (!result) {
    const label = getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
    toast.error(
      translate(
        'auto.components.tab.bar.TabBar.ab589350e5',
        'Could not build launch command for {{value0}}.',
        {
          value0: label
        }
      )
    )
    return
  }
  if (result.surface.kind === 'local-terminal') {
    context.onLocalTerminal(result.surface.tabId)
    return
  }
  if (shouldQueueTerminalFocusAfterMenuClose(result)) {
    context.onHostTerminal()
  }
}
