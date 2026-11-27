import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { HostMeshSnapshot } from '../../../../../../preload/api/host-mesh-api'
import { ServerListRow, ServerRowChip } from '../../host-rows/ServerListRow'
import { HostGroupSection } from './HostGroupSection'
import { MeshMemberChip, MeshMemberMenuItems } from './mesh-member-affordance'
import { publishHostMeshSnapshot } from './host-mesh-shared-state'

/**
 * The mesh as settings renders it, without Electron or a real peer.
 *
 * Why a fixture and not the app: the states worth looking at are "one pair complete, one one-way" and "mesh off",
 * neither of which a single machine can produce through the real protocol — and the pane is presentational once a
 * snapshot exists.
 */

const HUB = 'hub-key-00000000'
const LAPTOP = 'laptop-key-1111'
const STUDIO = 'studio-key-2222'

function snapshot(overrides: Partial<HostMeshSnapshot> = {}): HostMeshSnapshot {
  return {
    inGroup: true,
    groupId: 'mesh-0000000000000000',
    selfKey: HUB,
    members: [
      {
        hostKey: STUDIO,
        label: 'studio',
        status: 'complete',
        environmentId: 'env-studio'
      },
      {
        hostKey: LAPTOP,
        label: 'macbook-pro-16',
        status: 'half',
        environmentId: 'env-laptop'
      }
    ],
    summary: { memberCount: 2, completePairs: 1, halfPairs: 1, missingPairs: 0, atCap: false },
    settings: { enabled: true },
    lastError: null,
    lastSyncedAt: 1_795_712_900_000,
    lastPassReached: 2,
    migration: { appliedAt: 1_795_712_859_694, peerCount: 2 },
    ...overrides
  }
}

function installMeshApi(value: HostMeshSnapshot): void {
  publishHostMeshSnapshot(value)
  const api: Record<string, unknown> = window.api
  api.hostMesh = {
    read: async () => value,
    join: async () => ({ kind: 'joined', snapshot: value, muted: [] }),
    remove: async () => value,
    leave: async () => value,
    settings: async () => value
  }
}

function section(value: HostMeshSnapshot) {
  return defineFixture({
    width: 720,
    setup: () => installMeshApi(value),
    render: () => (
      <div className="space-y-3 p-4">
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          <ServerListRow
            name="studio"
            meta={<span className="truncate">ws://192.0.2.12:6768</span>}
            chips={<MeshMemberChip environmentId="env-studio" />}
            status={{ label: 'Connected', tone: 'success' }}
          />
          <ServerListRow
            name="macbook-pro-16"
            meta={<span className="truncate">ws://192.0.2.13:6768</span>}
            chips={<MeshMemberChip environmentId="env-laptop" />}
            status={{ label: 'Connected', tone: 'success' }}
          />
          <ServerListRow
            name="unpaired-box"
            meta={<span className="truncate">ws://192.0.2.14:6768</span>}
            chips={<MeshMemberChip environmentId="env-unpaired" />}
            status={{ label: 'Connected', tone: 'success' }}
          />
        </div>
        <HostGroupSection />
      </div>
    )
  })
}

export const meshOn = section(snapshot())

export const meshOff = section(snapshot({ settings: { enabled: false } }))

/** The one case the section still lists: a member this computer holds no way to reach. */
export const withUnreachableMember = section(
  snapshot({
    members: [
      {
        hostKey: STUDIO,
        label: 'studio',
        status: 'complete',
        environmentId: 'env-studio'
      },
      {
        hostKey: 'vm-key-3333',
        label: 'build-vm',
        status: 'missing',
        environmentId: null
      }
    ],
    summary: { memberCount: 2, completePairs: 1, halfPairs: 0, missingPairs: 1, atCap: false }
  })
)

/** Not in a mesh yet: what a machine shows before anything has paired it back. */
export const notInMesh = section(
  snapshot({
    inGroup: false,
    groupId: '',
    members: [],
    summary: { memberCount: 0, completePairs: 0, halfPairs: 0, missingPairs: 0, atCap: false },
    migration: null
  })
)

/** The row affordance alone, both states, so the chip and the menu actions are reviewable on their own. */
export const rowAffordance = defineFixture({
  width: 480,
  setup: () => installMeshApi(snapshot()),
  render: () => (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      <ServerListRow
        name="studio"
        chips={<MeshMemberChip environmentId="env-studio" />}
        menuItems={<MeshMemberMenuItems environmentId="env-studio" onAction={() => {}} />}
        status={{ label: 'Connected', tone: 'success' }}
      />
      <ServerListRow
        name="macbook-pro-16"
        chips={<MeshMemberChip environmentId="env-laptop" />}
        status={{ label: 'Connected', tone: 'success' }}
      />
      <ServerListRow
        name="unpaired-box"
        chips={
          <>
            <ServerRowChip>SSH tunnel</ServerRowChip>
            <MeshMemberChip environmentId="env-unpaired" />
          </>
        }
        status={{ label: 'Connected', tone: 'success' }}
      />
    </div>
  )
})
