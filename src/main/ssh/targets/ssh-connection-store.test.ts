import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './testing/ssh-connection-store-test-fixture'
import type { SshTarget } from '../../../shared/ssh-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  loadUserSshConfigWithText: () => {
    const hosts = loadUserSshConfigMock()
    return { hosts, text: JSON.stringify(hosts ?? []) }
  },
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

describe('SshConnectionStore', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let sshStore: SshConnectionStore

  beforeEach(() => {
    mockStore = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the Store methods SshConnectionStore calls.
    sshStore = new SshConnectionStore(mockStore as never, { config: async () => null })
    loadUserSshConfigMock.mockReset()
    sshConfigHostsToTargetsMock.mockReset()
  })

  describe('importFromSshConfig', () => {
    function candidate(overrides: Partial<SshTarget> & { configHost: string }): SshTarget {
      return {
        id: `tmp-${overrides.configHost}`,
        label: overrides.configHost,
        host: `${overrides.configHost}.example.com`,
        port: 22,
        username: '',
        ...overrides
      }
    }

    it('keeps a case-only alias variant suppressed after the host was deleted', async () => {
      const added = sshStore.addTarget({
        label: 'Prod',
        configHost: 'Prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })
      sshStore.removeTarget(added.id)
      loadUserSshConfigMock.mockReturnValue([{ host: 'prod' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'prod' })])

      const result = (await sshStore.importFromSshConfig()).targets

      expect(result).toEqual([])
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
    })

    it('lifts a tombstone stored under different casing when the host is re-added', () => {
      const added = sshStore.addTarget({
        label: 'Prod',
        configHost: 'Prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })
      sshStore.removeTarget(added.id)
      sshStore.addTarget({
        label: 'prod',
        configHost: 'prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })

      expect(sshStore.listSuppressedSshConfigAliases()).toEqual([])
    })
  })

  describe('deleted config host tombstones', () => {
    function candidate(overrides: Partial<SshTarget> & { configHost: string }): SshTarget {
      return {
        id: `tmp-${overrides.configHost}`,
        label: overrides.configHost,
        host: `${overrides.configHost}.example.com`,
        port: 22,
        username: '',
        ...overrides
      }
    }

    it('reAdopt clears all tombstones and re-imports the deleted host', async () => {
      mockStore.addDeletedSshConfigAlias('mini')
      loadUserSshConfigMock.mockReturnValue([{ host: 'mini' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'mini' })])

      const result = (await sshStore.importFromSshConfig({ reAdopt: true })).targets

      expect(mockStore.clearDeletedSshConfigAliases).toHaveBeenCalled()
      expect(mockStore.addSshTarget).toHaveBeenCalledWith(
        expect.objectContaining({ configHost: 'mini', source: 'ssh-config' })
      )
      expect(result).toHaveLength(1)
    })
  })
  describe('setTargetHidden', () => {
    function seedConfigTarget(overrides: Partial<SshTarget> = {}): SshTarget {
      const target: SshTarget = {
        id: 'ssh-config-1',
        label: 'cluster',
        configHost: 'cluster',
        host: '10.0.0.5',
        port: 22,
        username: 'dev',
        source: 'ssh-config',
        ...overrides
      }
      mockStore.addSshTarget(target)
      return target
    }

    it('hides a config-imported target and reports the updated row', () => {
      seedConfigTarget()

      expect(sshStore.setTargetHidden('ssh-config-1', true)).toEqual(
        expect.objectContaining({ id: 'ssh-config-1', hidden: true })
      )
      expect(sshStore.getTarget('ssh-config-1')?.hidden).toBe(true)
    })

    it('unhides a target again', () => {
      seedConfigTarget({ hidden: true })

      expect(sshStore.setTargetHidden('ssh-config-1', false)?.hidden).toBe(false)
    })

    // The rule the pane depends on: a host the user added has no config entry to
    // resurrect it, so it is removed rather than hidden, and hiding one is a bug.
    it('refuses to hide a target the user added in Orca', () => {
      mockStore.addSshTarget({
        id: 'ssh-manual',
        label: 'mine',
        host: 'mine.example.com',
        port: 22,
        username: 'dev',
        source: 'manual'
      })

      expect(() => sshStore.setTargetHidden('ssh-manual', true)).toThrow('ssh_target_not_hideable')
      expect(sshStore.getTarget('ssh-manual')?.hidden).toBeUndefined()
    })

    // Legacy targets predate `source`; the import shape still marks them as discovered.
    it('hides a legacy config-shaped target that has no source stamp', () => {
      mockStore.addSshTarget({
        id: 'ssh-legacy',
        label: 'old',
        configHost: 'old',
        host: 'old.example.com',
        port: 22,
        username: 'dev'
      })

      expect(sshStore.setTargetHidden('ssh-legacy', true)?.hidden).toBe(true)
    })

    it('returns null for an unknown target', () => {
      expect(sshStore.setTargetHidden('missing', true)).toBeNull()
    })

    it('keeps the hidden flag across a config sync that rewrites the endpoint', async () => {
      seedConfigTarget({ hidden: true })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        {
          id: 'tmp-cluster',
          configHost: 'cluster',
          label: 'cluster',
          host: '10.0.0.5',
          port: 2222,
          username: 'dev'
        }
      ])

      // Why awaited: upstream's import returns { targets, repoReadoptions } and writes asynchronously.
      await sshStore.importFromSshConfig()

      // A sync must not be a back door that un-hides the host.
      expect(sshStore.getTarget('ssh-config-1')?.hidden).toBe(true)
      expect(mockStore.updateSshTarget).toHaveBeenCalledWith(
        'ssh-config-1',
        expect.not.objectContaining({ hidden: false })
      )
    })
  })
})
