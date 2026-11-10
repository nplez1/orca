import { describe, expect, it } from 'vitest'
import { buildAutomationHostCatalog } from '../hosts/automation-host-catalog'
import type {
  AutomationCatalogHydrationEvidence,
  AutomationCatalogSshMirrorInput,
  AutomationHostCatalogEntry
} from '../hosts/automation-host-catalog-types'
import {
  automationCreateHostOffered,
  automationCreateHostStableKey,
  automationCreateProjectMismatch,
  automationCreateUpdateRequiredAuthorityLabels,
  preselectAutomationCreateHost,
  resolveAutomationCreateDestination,
  revalidateAutomationCreateDestination,
  soleAutomationCreateHost
} from './automation-create-destination'
import { groupReposByAutomationAuthority } from '../hosts/automation-authority-identity'
import type { Repo } from '../../../../../shared/repo-types'

function mirror(
  targets: AutomationCatalogSshMirrorInput['targets']
): AutomationCatalogSshMirrorInput {
  return {
    targetsHydrated: true,
    targets,
    removedTargetLabels: new Map(),
    connectionStatusByTargetId: new Map()
  }
}

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    stableKey: 'host:desktop:self',
    label: 'This computer',
    authorityLabel: 'This computer',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function sshEntry(targetGeneration: number): AutomationHostCatalogEntry {
  return entry({
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'box' } },
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration }
    },
    stableKey: 'host:desktop:ssh:box',
    kind: 'ssh'
  })
}

describe('create destination resolution', () => {
  it('states the destination from the chosen host', () => {
    expect(resolveAutomationCreateDestination(entry())).toMatchObject({
      status: 'ready',
      authority: { kind: 'desktop' },
      destination: { selector: { kind: 'self' } }
    })
  })

  it('asks for a choice instead of defaulting one', () => {
    expect(resolveAutomationCreateDestination(null)).toEqual({
      status: 'choice-required',
      reason: 'unselected'
    })
    expect(resolveAutomationCreateDestination(entry({ kind: 'orphan' }))).toEqual({
      status: 'choice-required',
      reason: 'orphan'
    })
    expect(resolveAutomationCreateDestination(entry({ owner: null }))).toEqual({
      status: 'choice-required',
      reason: 'unavailable'
    })
  })

  it('refuses a view-only host even when it still carries an owner', () => {
    // A degraded query contract means the record could not be listed or edited
    // back after landing; the badge and the create gate must agree.
    for (const querySupport of ['legacy-unscoped', 'incompatible'] as const) {
      expect(resolveAutomationCreateDestination(entry({ querySupport }))).toEqual({
        status: 'choice-required',
        reason: 'unavailable'
      })
    }
  })

  it('prefers the explicit selection and only then the active workspace', () => {
    const entries = [entry(), sshEntry(3)]
    expect(
      preselectAutomationCreateHost(entries, 'host:desktop:ssh:box', 'host:desktop:self')?.stableKey
    ).toBe('host:desktop:ssh:box')
    expect(preselectAutomationCreateHost(entries, null, 'host:desktop:self')?.stableKey).toBe(
      'host:desktop:self'
    )
    // An unresolvable workspace host leaves the choice open rather than picking one.
    expect(preselectAutomationCreateHost(entries, null, 'host:desktop:ssh:gone')).toBeNull()
    expect(preselectAutomationCreateHost(entries, null, null)).toBeNull()
  })
})

describe('create destination revalidation', () => {
  const captured = {
    authority: { kind: 'desktop' } as const,
    destination: { selector: { kind: 'ssh' as const, targetId: 'box', targetGeneration: 3 } },
    entry: sshEntry(3)
  }

  it('accepts a destination whose incarnation is unchanged', () => {
    expect(revalidateAutomationCreateDestination(captured, [sshEntry(3)]).status).toBe('ready')
  })

  it('reports a re-registered target as stale rather than following it', () => {
    expect(revalidateAutomationCreateDestination(captured, [sshEntry(4)])).toMatchObject({
      status: 'stale'
    })
  })

  it('reports a host that left the catalog as needing a choice', () => {
    expect(revalidateAutomationCreateDestination(captured, [])).toEqual({
      status: 'choice-required',
      reason: 'unselected'
    })
  })
})

describe('offered create hosts', () => {
  it('offers an ineligible host rather than hiding it', () => {
    // The regression this pins: a connected host on a pre-host-scoping server
    // is ineligible, and hiding it removed every connected host from the picker.
    expect(
      automationCreateHostOffered(
        entry({
          querySupport: 'legacy-unscoped',
          scopeGap: 'authority-unscoped'
        })
      )
    ).toBe(true)
    expect(automationCreateHostOffered(entry({ owner: null, catalogState: 'unhydrated' }))).toBe(
      true
    )
  })

  it('hides only rows that can never become destinations', () => {
    expect(automationCreateHostOffered(entry({ kind: 'orphan' }))).toBe(false)
    expect(automationCreateHostOffered(entry({ owner: null, catalogState: 'removed' }))).toBe(false)
  })

  // Hiding is not removal: the row stays in the catalog so an automation already stored
  // on it still resolves, but the create picker must stop offering it.
  it('does not offer a host the user hid', () => {
    expect(automationCreateHostOffered(sshEntry(3))).toBe(true)
    expect(automationCreateHostOffered({ ...sshEntry(3), hidden: true })).toBe(false)
  })

  it('still resolves a destination on a hidden host for an existing automation', () => {
    expect(resolveAutomationCreateDestination({ ...sshEntry(3), hidden: true })).toMatchObject({
      status: 'ready',
      destination: { selector: { kind: 'ssh', targetId: 'box' } }
    })
  })

  it('names the authorities a server update would repair, once each', () => {
    const legacySelf = entry({
      stableKey: 'runtime:r1:self',
      authorityLabel: 'legacy-box',
      querySupport: 'legacy-unscoped',
      scopeGap: 'authority-unscoped'
    })
    const legacySshChild = entry({
      stableKey: 'runtime:r1:ssh:box',
      kind: 'ssh',
      authorityLabel: 'legacy-box',
      querySupport: 'legacy-unscoped',
      scopeGap: 'authority-unscoped'
    })
    const incompatible = entry({
      stableKey: 'runtime:r2:self',
      authorityLabel: 'older-box',
      querySupport: 'incompatible'
    })
    expect(
      automationCreateUpdateRequiredAuthorityLabels([
        entry(),
        legacySelf,
        legacySshChild,
        incompatible
      ])
    ).toEqual(['legacy-box', 'older-box'])
  })

  it('does not blame the server for hosts another repair or none would fix', () => {
    // Unverified since disconnect: the repair is a reconnect, not an update.
    const unverified = entry({
      stableKey: 'host:desktop:ssh:cold',
      kind: 'ssh',
      querySupport: 'legacy-unscoped',
      scopeGap: 'target-unverified'
    })
    // Scoped but not yet hydrated: disabled, and no repair to name.
    const unhydrated = entry({
      stableKey: 'host:desktop:ssh:warm',
      kind: 'ssh',
      owner: null,
      catalogState: 'unhydrated'
    })
    expect(automationCreateUpdateRequiredAuthorityLabels([unverified, unhydrated])).toEqual([])
  })
})

describe('sole create host', () => {
  const hydrated: AutomationCatalogHydrationEvidence = {
    runtimeCatalogSettled: true,
    desktopSshHydrated: true,
    runtimeSshHydratedByEnvironmentId: new Map(),
    savedRuntimeEnvironmentIds: new Set(),
    orphanSettledAuthorityKeys: new Set(),
    unavailableAuthorityKeys: new Set()
  }

  it('states the only eligible host and never one of several', () => {
    expect(soleAutomationCreateHost([entry()], hydrated)?.stableKey).toBe('host:desktop:self')
    expect(soleAutomationCreateHost([entry(), sshEntry(3)], hydrated)).toBeNull()
    // An orphan bucket, an unowned host, and a view-only host are not candidates at all.
    expect(
      soleAutomationCreateHost([entry(), entry({ stableKey: 'orphan', kind: 'orphan' })], hydrated)
        ?.stableKey
    ).toBe('host:desktop:self')
    expect(
      soleAutomationCreateHost(
        [entry(), entry({ stableKey: 'legacy', querySupport: 'legacy-unscoped' })],
        hydrated
      )?.stableKey
    ).toBe('host:desktop:self')
  })

  it('states nothing until the catalog has settled', () => {
    expect(
      soleAutomationCreateHost([entry()], { ...hydrated, runtimeCatalogSettled: false })
    ).toBeNull()
    expect(
      soleAutomationCreateHost([entry()], { ...hydrated, desktopSshHydrated: false })
    ).toBeNull()
  })
})

describe('create host stable key', () => {
  it('maps a workspace host to the catalog host that would store its automations', () => {
    expect(automationCreateHostStableKey('local')).toBe('host:desktop:self')
    // A desktop SSH workspace is still desktop-stored; only the selector differs.
    expect(automationCreateHostStableKey('ssh:box')).toBe('host:desktop:ssh:box')
    expect(automationCreateHostStableKey('runtime:gpu')).toBe('host:runtime:gpu:self')
    expect(automationCreateHostStableKey(null)).toBeNull()
  })
})

describe('create project mismatch', () => {
  function repo(overrides: Partial<Repo>): Repo {
    return {
      id: 'repo-1',
      displayName: 'orca',
      path: '/repos/orca',
      badgeColor: '#000000',
      addedAt: 1,
      worktreeBaseRef: 'main',
      ...overrides
    }
  }
  const desktopSelf = {
    authority: { kind: 'desktop' } as const,
    destination: { selector: { kind: 'self' as const } },
    entry: entry()
  }

  it('refuses a project the destination authority does not hold as local', () => {
    const tables = groupReposByAutomationAuthority([
      repo({ id: 'runtime-repo', executionHostId: 'runtime:gpu' }),
      repo({ id: 'ssh-repo', connectionId: 'box' })
    ])
    // No connection ID is not evidence of local: this repo is the runtime's.
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'runtime-repo')).toBe(true)
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'ssh-repo')).toBe(true)
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'repo-1')).toBe(true)
  })
})

describe('create destination on a managed SSH host', () => {
  it("lists only the host's server and lands its desktop SSH key there", () => {
    const { entries } = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror([{ targetId: 'box', label: 'Build box', generation: 2 }])
      },
      runtimes: [
        {
          environmentId: 'env-1',
          label: 'Build box',
          pairingRevision: 3,
          authorityHealth: 'fresh',
          querySupport: 'scoped',
          ssh: mirror([]),
          managedSshTargetId: 'box'
        }
      ],
      runtimeCatalogSettled: true
    })
    const desktopSshKey = 'host:desktop:ssh:box'

    const desktopSsh = entries.find((entry) => entry.stableKey === desktopSshKey)
    expect(desktopSsh && automationCreateHostOffered(desktopSsh)).toBe(false)
    expect(preselectAutomationCreateHost(entries, desktopSshKey, null)?.stableKey).toBe(
      'host:runtime:env-1:self'
    )
  })
})
