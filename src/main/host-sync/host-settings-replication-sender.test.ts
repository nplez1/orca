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
    unreadableIds: () => [],
    protectionOf: () => 'sealed',
    list: () => [credential],
    apply: () => {},
    remove: () => {}
  }
}

const empty: HostSettingsCredentialPort = {
  kind: 'empty',
  canSeal: () => true,
  unreadableIds: () => [],
  protectionOf: () => null,
  list: () => [],
  apply: () => {},
  remove: () => {}
}

describe('building what the main sends', () => {
  it('never names an unreadable credential as a removal', async () => {
    // Why this is the dangerous case: "absent from upserts" otherwise means "deleted", so a transient
    // keyring failure on the main would read as a deletion on every host and the host would throw away
    // a working credential.
    const unreadable: HostSettingsCredentialPort = {
      ...empty,
      kind: 'api-key:deepseek',
      unreadableIds: () => ['api-key:deepseek']
    }

    const snapshot = await buildHostSettingsSnapshot([unreadable], 2, ['api-key:deepseek'])

    expect(snapshot.removals).toEqual([])
    expect(snapshot.unreadable).toEqual(['api-key:deepseek'])
  })

  it('still names a credential it no longer holds as a removal', async () => {
    const payload = await buildHostSettingsSnapshot([empty], 2, ['api-key:deepseek'])

    expect(payload.removals).toEqual(['api-key:deepseek'])
    expect(payload.unreadable).toEqual([])
  })

  it('sends every held credential as a snapshot a brand-new host can apply', async () => {
    const payload = await buildHostSettingsSnapshot(
      [port('api-key:deepseek'), port('jira:site-1')],
      1
    )

    expect(payload.baseRevision).toBeNull()
    expect(payload.revision).toBe(1)
    expect(payload.upserts.map((credential) => credential.id)).toEqual([
      'api-key:deepseek',
      'jira:site-1'
    ])
    expect(payload.removals).toEqual([])
  })

  it('sends an empty snapshot when the main holds nothing', async () => {
    expect((await buildHostSettingsSnapshot([empty], 1)).upserts).toEqual([])
  })

  it('names what the main no longer holds as a removal', async () => {
    const payload = await buildHostSettingsDelta({
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

  it('re-sends a credential whose value changed, because a port reports what it holds', async () => {
    const payload = await buildHostSettingsDelta({
      ports: [port('jira:site-1')],
      previousCredentialIds: ['jira:site-1'],
      baseRevision: 4,
      revision: 5
    })

    expect(payload.upserts).toHaveLength(1)
    expect(payload.removals).toEqual([])
  })
})
