import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/native-chat-covered-pane'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { refreshTerminalImeInputContext } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import {
  findRegisteredTerminalTab,
  focusRuntimeTerminalSurface
} from '@/runtime/mounted-terminal-tab-registry'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { useAppStore } from '@/store'
import { isEventTargetInsideCurrentTarget } from '@/components/sidebar/worktree-card-dom-events'

/**
 * One policy for where keyboard focus belongs after a pointer gesture.
 *
 * Orca is an agent-first environment: focus position *is* the shortcut context
 * (`getKeybindingContext` returns 'terminal' only while the xterm helper owns
 * focus), so a click on chrome that has no use for typed input must hand focus
 * back to the displayed agent tab instead of stranding it on a listbox or a
 * panel button. Focus leaves the agent only when the interaction lands in an
 * editable, opens an overlay, is the keyboard-driven sidebar, or the element
 * opts out with `data-keep-keyboard-focus`.
 */

/** Escape hatch for chrome that owns keyboard focus itself (e.g. another agent surface). */
const KEEP_KEYBOARD_FOCUS_ATTRIBUTE = 'data-keep-keyboard-focus'

/** Spread onto chrome that keeps the caret while the policy restores the agent tab. */
export const keepKeyboardFocusOptOut = {
  [KEEP_KEYBOARD_FOCUS_ATTRIBUTE]: ''
}

const KEYBOARD_NAVIGATION_SIDEBAR = '[data-worktree-sidebar][data-keyboard-navigation]'
// Why: a workspace card owns its own restore — activation may be followed by a sleeping
// workspace publishing its tab, which only the deferral path can wait for.
const WORKSPACE_CARD_SELECTOR = '[role="option"][data-worktree-id]'
// Why: a control inside a card (its unread toggle, its menu button) is ordinary chrome —
// only a plain click on the card itself is the activation.
const NESTED_CONTROL_SELECTOR =
  'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="checkbox"], [role="switch"]'

/** The parts of a React click event these handlers read. */
export type ChromeClickEvent = {
  currentTarget: EventTarget | null
  target: EventTarget | null
  detail: number
}

export type AgentTabFocusTarget = {
  worktreeId: string
  tabId: string
  leafId: string | null
}

/**
 * The agent tab currently on screen, resolved from the store at call time so a
 * folder workspace or a paired/SSH host resolves exactly like a local worktree.
 */
function resolveAgentTabFocusTarget(): AgentTabFocusTarget | null {
  const state = useAppStore.getState()
  // Why: settings, tasks, activity and mobile replace the agent surface; there is
  // nothing to hand focus back to, so focus stays where the interaction put it.
  if (state.activeView !== 'terminal' || state.activeTabType !== 'terminal') {
    return null
  }
  const worktreeId = state.activeWorktreeId
  const tabId = state.activeTabId
  if (!worktreeId || !tabId) {
    return null
  }
  return {
    worktreeId,
    tabId,
    leafId: state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null
  }
}

/** Whether something more specific than the agent tab owns keyboard focus right now. */
export function isAgentTabFocusClaimed(
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement
): boolean {
  if (activeElement === null) {
    return false
  }
  // Why: a terminal already holds the caret, and the floating workspace is another
  // agent context — a click elsewhere must not pull the caret out of it.
  if (activeElement.closest('.xterm')) {
    return true
  }
  if (shouldPreserveEditableFocus(activeElement)) {
    return true
  }
  // Why: an opt-out that is no longer on screen (a closed floating workspace) must
  // not keep owning focus, mirroring shouldPreserveEditableFocus's hidden rule.
  const optedOut = activeElement.closest(`[${KEEP_KEYBOARD_FOCUS_ATTRIBUTE}]`)
  if (optedOut !== null && optedOut.closest('[aria-hidden="true"]') === null) {
    return true
  }
  // Why: while the worktree list is driven by the keyboard, focus belongs in it.
  if (activeElement.closest(KEYBOARD_NAVIGATION_SIDEBAR)) {
    return true
  }
  // Why: a live dialog or menu owns the caret until it closes, and an overlay
  // animating out no longer outranks us.
  return hasVisibleOverlay({ ignoreDismissed: true })
}

function hasChromeTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false
  }
  const selection = window.getSelection()
  // Why: a live selection means the user is copying chrome text, and taking focus
  // would grey it out. Conservative on purpose — it is checked at call time, so a
  // stale selection anywhere only ever leaves focus where the gesture put it.
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0
}

function refreshRestoredTerminalImeContext(): void {
  // Why: only a DOM host has an input context to rebuild.
  if (typeof HTMLElement === 'undefined') {
    return
  }
  const active = document.activeElement
  if (active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea')) {
    // Why: macOS keeps a stale NSTextInputContext on an xterm helper that lost and
    // regained focus, which breaks CJK input until the context is rebuilt.
    refreshTerminalImeInputContext(active, {})
  }
}

function terminalSurfaceOwnsFocus(tabId: string, worktreeId: string): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const container = findRegisteredTerminalTab(tabId, worktreeId)?.tab.getContainer() ?? null
  const active = document.activeElement
  return container !== null && active !== null && container.contains(active)
}

/**
 * Focus the agent surface for `target`. Returns false when nothing in the tab could
 * take focus — a terminal that has not mounted yet, or one an open overlay is
 * holding focus away from — so a caller that waits can retry.
 *
 * Why the mounted-tab registry rather than `focusTerminalTabSurface`: a defaulter
 * needs a synchronous answer about whether focus landed, and the DOM-based helper
 * defers for two frames and reports nothing.
 */
export function focusAgentTabSurface(target: AgentTabFocusTarget): boolean {
  const registered = findRegisteredTerminalTab(target.tabId, target.worktreeId)?.tab
  const manager = registered?.getManager()
  if (!registered || !manager) {
    return false
  }
  // Why: realign the manager to the stored split first, so chat-versus-terminal is
  // judged on the pane this restore aims at. A split can hold a chat in one leaf and
  // a terminal in another, and the manager's active pane may still be the other one.
  const leafRequested =
    target.leafId !== null &&
    focusRuntimeTerminalSurface(target.tabId, target.leafId, target.worktreeId)
  const aimedPane = manager.getActivePane() ?? manager.getPanes()[0] ?? null
  if (aimedPane !== null && paneIsCoveredByNativeChat(aimedPane)) {
    // Why: a chat over the terminal owns the composer, so focusing the covered xterm
    // would take the caret out of what the user is typing into. Only a composer that
    // actually took focus counts, or a waiting caller would stop before it mounts.
    requestNativeChatComposerFocus(target.tabId)
    return terminalSurfaceOwnsFocus(target.tabId, target.worktreeId)
  }
  // Why: a leaf request reports success once it has asked, even when an overlay or a
  // still-unmounting pane swallowed the focus — so it only counts when focus landed.
  if (leafRequested && terminalSurfaceOwnsFocus(target.tabId, target.worktreeId)) {
    refreshRestoredTerminalImeContext()
    return true
  }
  // Why: the manager's active pane is the active leaf, and this path verifies focus.
  if (!focusRuntimeTerminalSurface(target.tabId, null, target.worktreeId)) {
    return false
  }
  refreshRestoredTerminalImeContext()
  return true
}

/** Restore focus to the displayed agent tab, unless the interaction claimed it. */
function restoreAgentTabFocusUnlessClaimed(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const target = resolveAgentTabFocusTarget()
  if (!target || hasChromeTextSelection() || isAgentTabFocusClaimed()) {
    return false
  }
  return focusAgentTabSurface(target)
}

/**
 * For a click on sidebar chrome. Cards and portaled menus/dialogs the sidebar owns are
 * not chrome clicks: a card defers to `queueWorkspaceActivationTerminalFocus`, and a
 * menu walks focus back to its trigger when it closes.
 */
export function restoreAgentTabFocusAfterChromeClick(event: ChromeClickEvent): void {
  if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
    return
  }
  const card =
    event.target instanceof Element ? event.target.closest(WORKSPACE_CARD_SELECTOR) : null
  if (card !== null && !clickedControlInside(event.target, card)) {
    return
  }
  restoreAgentTabFocusAfterGesture(event.detail)
}

function clickedControlInside(target: EventTarget | null, card: Element): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  const control = target.closest(NESTED_CONTROL_SELECTOR)
  return control !== null && card.contains(control)
}

/** For a click on a right-sidebar panel body; see `restoreAgentTabFocusAfterBackgroundClick`. */
export function restoreAgentTabFocusAfterPanelBackgroundClick(event: ChromeClickEvent): void {
  // Why: React click events bubble through portals, so a menu the panel owns must not
  // read as a click on the panel background.
  if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
    return
  }
  restoreAgentTabFocusAfterBackgroundClick(event.detail)
}

/**
 * For chrome whose own click may mount a dialog, menu or autofocused field: the
 * claim can only be judged once the gesture's effects have committed, so decide
 * one frame later instead of racing the thing the click opened.
 *
 * `clickDetail` is the click event's `detail`: pass 1 for a gesture the caller knows
 * was a pointer click, or the event's own value where it has one.
 */
export function restoreAgentTabFocusAfterGesture(clickDetail: number): void {
  // Why: Enter or Space on a focused control synthesises a detail-0 click; a keyboard
  // user keeps their place, and only a pointer gesture hands focus back.
  if (clickDetail <= 0 || typeof requestAnimationFrame !== 'function') {
    return
  }
  requestAnimationFrame(() => {
    restoreAgentTabFocusUnlessClaimed()
  })
}

/**
 * For a click on panel background, which is where focus is dropped to the page
 * rather than moved somewhere. A click that landed on a focusable row keeps the
 * keyboard focus that row took (Explorer arrow navigation, for one).
 */
export function restoreAgentTabFocusAfterBackgroundClick(clickDetail: number): void {
  if (clickDetail <= 0 || typeof requestAnimationFrame !== 'function') {
    return
  }
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body && active !== document.documentElement) {
      return
    }
    restoreAgentTabFocusUnlessClaimed()
  })
}
