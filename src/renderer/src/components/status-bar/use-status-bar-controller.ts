import { useCallback, useEffect, useRef, useState } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '../../store'
import { selectFloatingWorkspaceHasUnread } from '../../store/selectors'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { getStatusBarUsageProjection } from './status-bar-usage-projection'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT, useStatusBarMenuFocusHandoff } from './ProviderDetailsMenu'
import { useStatusBarDensity } from './status-bar-density'

export function useStatusBarController(floatingTerminalOpen: boolean) {
  const floatingTerminalShortcut = useShortcutLabel('floatingTerminal.toggle')
  const rateLimits = useAppStore((s) => s.rateLimits)
  const settings = useAppStore((s) => s.settings)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const statusBarUsageMode = normalizeStatusBarUsageMode(useAppStore((s) => s.statusBarUsageMode))
  const setStatusBarUsageMode = useAppStore((s) => s.setStatusBarUsageMode)
  const [usageMenuOpen, setUsageMenuOpen] = useState(false)
  const usageMenuFocusHandoff = useStatusBarMenuFocusHandoff()
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const statusBarItems = useAppStore((s) => s.statusBarItems)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Why: reuse the floating-button's unread dot so activity shows for either trigger location (see FloatingTerminalToggleButton).
  const hasFloatingUnread = useAppStore(selectFloatingWorkspaceHasUnread)
  const floatingTerminalEnabled = settings?.floatingTerminalEnabled === true
  const floatingTerminalTriggerLocation =
    settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  // Why: gate per-CLI bars on PATH detection so an uninstalled agent isn't shown a noisy empty bar (auto re-shows when installed).
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  // Why: pet segment is driven purely by experimentalPet, not statusBarItems, to avoid double-toggling the surface (see design doc).
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const toggleStatusBarItem = useAppStore((s) => s.toggleStatusBarItem)
  const usageEmptyStateDismissed = useAppStore((s) => s.usageEmptyStateDismissed)
  const mountedRef = useRef(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const {
    density: { compact, usageTightestOnly, segmentsIconOnly, collapseUsage },
    overflowing,
    collapsedUsageProviders,
    barRef,
    usageRef,
    segmentsRef
  } = useStatusBarDensity()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: detect agents on mount so per-CLI usage bars hide when the CLI isn't installed; the slice dedupes concurrent callers.
  useEffect(() => {
    void ensureDetectedAgents()
  }, [ensureDetectedAgents])

  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      // Why: re-run PATH detection so a freshly-installed/removed CLI's bar appears/hides without restarting Orca.
      await Promise.all([refreshRateLimits(), refreshDetectedAgents()])
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [isRefreshing, refreshRateLimits, refreshDetectedAgents])

  if (!statusBarVisible) {
    return null
  }

  const {
    anyFetching,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    rosterProviders,
    showEmptyUsageCta
  } = getStatusBarUsageProjection({
    rateLimits,
    settings,
    statusBarItems,
    detectedAgentIds,
    usageEmptyStateDismissed
  })
  const showSsh = statusBarItems.includes('ssh')
  const showResourceUsage = statusBarItems.includes('resource-usage')
  const showPorts = statusBarItems.includes('ports')
  const showFloatingTerminalToggle =
    floatingTerminalEnabled && floatingTerminalTriggerLocation === 'status-bar'
  const anyVisible = hasVisibleUsageMeters || showResourceUsage

  const floatingTerminalActionLabel = floatingTerminalOpen
    ? 'Minimize Floating Workspace'
    : 'Show Floating Workspace'
  const showFloatingWorkspaceAttentionDot = !floatingTerminalOpen && hasFloatingUnread

  const handleManageAccounts = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'accounts', repoId: null })
    openSettingsPage()
  }
  const handleUsageDetails = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }
  const handleOpenProviderAccounts = (provider: ProviderRateLimits['provider']): void => {
    const sectionId = getUsageProviderAccountsSectionId(provider)
    if (!sectionId) {
      return
    }
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId })
    openSettingsPage()
  }
  const handleUsageMenuOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      usageMenuFocusHandoff.reset()
      recordFeatureInteraction('usage-tracking')
    }
    setUsageMenuOpen(nextOpen)
  }

  return {
    anyFetching,
    anyVisible,
    barRef,
    collapseUsage,
    collapsedUsageProviders,
    compact,
    detectedAgentIds,
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    isRefreshing,
    menuOpen,
    menuPoint,
    overflowing,
    petEnabled,
    recordFeatureInteraction,
    rosterProviders,
    segmentsIconOnly,
    segmentsRef,
    setMenuOpen,
    setMenuPoint,
    setStatusBarUsageMode,
    showEmptyUsageCta,
    showFloatingTerminalToggle,
    showFloatingWorkspaceAttentionDot,
    showPorts,
    showResourceUsage,
    showSsh,
    statusBarItems,
    statusBarUsageMode,
    toggleStatusBarItem,
    usageMenuFocusHandoff,
    usageMenuOpen,
    usagePercentageDisplay,
    usageRef,
    usageTightestOnly
  }
}

export type StatusBarController = NonNullable<ReturnType<typeof useStatusBarController>>
