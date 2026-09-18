import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { AgentDashboardDrawer } from '@/components/dashboard/AgentDashboardDrawer'

type AgentDashboardSidebarHostProps = {
  sidebarOpen: boolean
  workspaceBoardOpen: boolean
  closeWorkspaceBoard: () => void
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}

/** Opt-in dashboard coordination stays outside the normal sidebar path. */
export default function AgentDashboardSidebarHost({
  sidebarOpen,
  workspaceBoardOpen,
  closeWorkspaceBoard,
  leftSidebarStyle,
  statusBarVisible
}: AgentDashboardSidebarHostProps): React.JSX.Element | null {
  const drawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)
  const openAsPopout = useAppStore((s) => s.settings?.experimentalAgentDashboardMode === 'popout')
  // Why: only the TRANSITION into pop-out mode closes the drawer. The reverse
  // handoff opens it from the main process while this store may still carry the
  // old mode for a tick, and a level check would slam it shut again.
  const wasPopoutModeRef = useRef(openAsPopout)

  useEffect(() => {
    if (!sidebarOpen && drawerOpen) {
      setDrawerOpen(false)
    }
  }, [drawerOpen, setDrawerOpen, sidebarOpen])
  // Why: a mode change made elsewhere (the experiment pane) must not leave this
  // drawer showing behind a sidebar entry that now reads unselected.
  useEffect(() => {
    const wasPopout = wasPopoutModeRef.current
    wasPopoutModeRef.current = openAsPopout
    if (!wasPopout && openAsPopout && drawerOpen) {
      setDrawerOpen(false)
    }
  }, [drawerOpen, openAsPopout, setDrawerOpen])
  useEffect(() => {
    if (drawerOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, drawerOpen])
  useEffect(() => {
    if (workspaceBoardOpen) {
      setDrawerOpen(false)
    }
  }, [setDrawerOpen, workspaceBoardOpen])

  return sidebarOpen ? (
    <AgentDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
