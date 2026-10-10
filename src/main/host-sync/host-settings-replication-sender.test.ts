import { describe, expect, it } from 'vitest'
import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import {
  buildHostSettingsDelta,
  buildHostSettingsSnapshot
} from './host-settings-replication-sender'

function port(id: string): HostSettingsCredentialPort {
  const credential: ReplicatedHostCredential = {
    id,
    kind: id,
    label: id,
    protection: 'sealed',
    onlyIfEmpty: false,
    payload: `${id}-secret`
  }
  return {
    kind: id,
    canSeal: () => true,
    protectionOf: () => 'sealed',
    list: () => [credential],
    apply: () => {},
    remove: () => {}
  }
}

const empty: HostSettingsCredentialPort = {
  kind: 'empty',
  canSeal: () => true,
  protectionOf: () => null,
  list: () => [],
  apply: () => {},
  remove: () => {}
}

describe('building what the main sends', () => {
  it('sends every held credential as a snapshot a brand-new host can apply', () => {
    const payload = buildHostSettingsSnapshot([port('api-key:deepseek'), port('jira:site-1')], 1)

    expect(payload.baseRevision).toBeNull()
    expect(payload.revision).toBe(1)
    expect(payload.upserts.map((credential) => credential.id)).toEqual([
      'api-key:deepseek',
      'jira:site-1'
    ])
    expect(payload.removals).toEqual([])
  })

  it('sends an empty snapshot when the main holds nothing', () => {
    expect(buildHostSettingsSnapshot([empty], 1).upserts).toEqual([])
  })

  it('names what the main no longer holds as a removal', () => {
    const payload = buildHostSettingsDelta({
      ports: [port('jira:site-1')],
      previousCredentialIds: ['jira:site-1', 'jira:site-2'],
      baseRevision: 4,
      revision: 5
    })

    expect(payload.baseRevision).toBe(4)
    expect(payload.revision).toBe(5)
    expect(payload.upserts.map((credential) => credential.id)).toEqual(['jira:site-1'])
    expect(payload.removals).toEqual(['jira:site-2'])
  })

  it('re-sends a credential whose value changed, because a port reports what it holds', () => {
    const payload = buildHostSettingsDelta({
      ports: [port('jira:site-1')],
      previousCredentialIds: ['jira:site-1'],
      baseRevision: 4,
      revision: 5
    })

    expect(payload.upserts).toHaveLength(1)
    expect(payload.removals).toEqual([])
  })
})
