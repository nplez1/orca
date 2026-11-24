import { useAppStore } from '@/store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { BranchGroupMember } from '../../../../../../shared/sidebar-list/row-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../../shared/worktree/row-display/card-properties'
import WorktreeCard from '../surface/WorktreeCard'
import {
  FIXTURE_REPO,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from '../../worktree-card-slot-fixture-seeds'

const SIDEBAR_WIDTH = 320
const GROUP_KEY = 'project:repo-orca\u0000feature/host-picker'

const HOSTS: { hostId: ExecutionHostId; hostLabel: string }[] = [
  { hostId: 'local', hostLabel: 'Local Mac' },
  { hostId: 'ssh:gpu', hostLabel: 'GPU VM' },
  { hostId: 'ssh:build', hostLabel: 'Build server' }
]
// One workspace per host on the same branch, so Group by branch merges them into a single card.
const SEEDS: WorkspaceSeed[] = HOSTS.map((host) => ({
  id: `wt-stack-${host.hostId}`,
  name: 'host-picker',
  agents: [
    {
      agentType: 'claude',
      state: 'done',
      minutesAgo: 8,
      message: 'Split the host switcher out of the title row'
    }
  ]
}))
const OTHER_HOST_SEED: WorkspaceSeed = {
  id: 'wt-other-host',
  name: 'release-1.4-notes',
  agents: []
}

function stackFixture({
  selectedHostId = HOSTS[0].hostId,
  settings = {},
  interactive = false
}: {
  selectedHostId?: ExecutionHostId
  settings?: Record<string, unknown>
  interactive?: boolean
}) {
  const now = Date.now()
  const members: BranchGroupMember[] = SEEDS.map((seed, index) => ({
    worktree: {
      ...makeWorktree(seed, now),
      ...(HOSTS[index].hostId === 'local' ? {} : { hostId: HOSTS[index].hostId })
    },
    repo: FIXTURE_REPO,
    hostId: HOSTS[index].hostId,
    hostLabel: HOSTS[index].hostLabel
  }))
  const selected = members.find((member) => member.hostId === selectedHostId) ?? members[0]
  return defineFixture({
    width: SIDEBAR_WIDTH,
    setup: () => {
      seedWorkspaces([...SEEDS, OTHER_HOST_SEED], now)
      useAppStore.setState((state) => ({
        worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
        settings: state.settings ? { ...state.settings, ...settings } : state.settings
      }))
    },
    interact: interactive
      ? async (frame) => {
          frame
            .querySelector('[data-branch-host-select]')
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        }
      : undefined,
    render: () => (
      <div className="flex flex-col gap-0.5 bg-worktree-sidebar py-1.5 text-worktree-sidebar-foreground">
        <WorktreeCard
          worktree={selected.worktree}
          repo={FIXTURE_REPO}
          isActive={false}
          nativeDragEnabled={false}
          branchGroup={members}
          selectedBranchHostId={selected.hostId}
          branchGroupKey={GROUP_KEY}
          onSelectBranchHost={() => {}}
        />
        {/* The chip a single-host card draws for the same host, for comparison. */}
        <WorktreeCard
          worktree={makeWorktree(OTHER_HOST_SEED, now)}
          repo={FIXTURE_REPO}
          isActive={false}
          nativeDragEnabled={false}
          hostContextLabel="Build server"
        />
      </div>
    )
  })
}

export const stackedHosts = stackFixture({})
export const stackedHostsMenuOpen = stackFixture({ interactive: true })
export const stackedHostsNoDetailsRow = stackFixture({
  settings: { worktreeCardDetailsRow: false }
})
export const stackedHostsClassic = stackFixture({
  selectedHostId: 'ssh:gpu',
  settings: { experimentalNewWorktreeCardStyle: false }
})
