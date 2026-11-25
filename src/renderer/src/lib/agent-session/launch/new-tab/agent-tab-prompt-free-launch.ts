/** Session-only: tabs this window launched with no prompt, draft or argument override. Absence (reload, eviction, other launch paths) means unknown, never empty. */

const MAX_REMEMBERED_LAUNCHES = 256
const promptFreeTabIds = new Set<string>()

export function notePromptFreeAgentTabLaunch(tabId: string): void {
  promptFreeTabIds.delete(tabId)
  promptFreeTabIds.add(tabId)
  for (const oldest of promptFreeTabIds) {
    if (promptFreeTabIds.size <= MAX_REMEMBERED_LAUNCHES) {
      break
    }
    promptFreeTabIds.delete(oldest)
  }
}

export function wasAgentTabLaunchedPromptFree(tabId: string): boolean {
  return promptFreeTabIds.has(tabId)
}
