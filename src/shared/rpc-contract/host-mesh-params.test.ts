import { describe, expect, it } from 'vitest'
import { HOST_MESH_METHODS } from '../../main/runtime/rpc/methods/host-mesh'
import { HOST_MESH_PAYLOAD_VERSION } from '../host-mesh/host-mesh-contract'
import { getCompiledSchema } from '../../main/schema-validation/zod-schema-compilation'
import type { RpcAnyMethodDeclaration } from '../../main/runtime/rpc/core'

/**
 * The wire shape of `hostMesh.sync`, pinned to what the method actually validates.
 *
 * Why this exists: a strict schema that predates one field is invisible until a real fleet disagrees — #492 added
 * `endpoints` to the sync request and the method kept `pending`'s schema, so every sync was answered
 * `invalid_argument`, no pair could ever report `ok`, and every host read one-way. The driver's own suite could not
 * see it because its fake peer casts params instead of validating them, so the check belongs here, against the
 * declaration the dispatcher uses.
 */

function declarationFor(method: string): RpcAnyMethodDeclaration {
  const declaration = HOST_MESH_METHODS.find((entry) => entry.name === method)
  if (declaration === undefined) {
    throw new Error(`no declaration for ${method}`)
  }
  return declaration
}

function parseFor(method: string, params: unknown) {
  const declaration = declarationFor(method)
  if (declaration.params === null) {
    throw new Error(`${method} takes no params`)
  }
  return getCompiledSchema(declaration.params).safeParse(params)
}

const SYNC_REQUEST = {
  version: HOST_MESH_PAYLOAD_VERSION,
  groupId: 'mesh-6859b8cb658a71e5',
  hostKey: 'e86b9852850c0e5bc1e33523ce23e2f1'
}

describe('hostMesh.sync params', () => {
  it('accepts the sync request the driver sends, endpoints included', () => {
    const withEndpoints = parseFor('hostMesh.sync', {
      ...SYNC_REQUEST,
      endpoints: ['ws://192.168.1.75:6768', 'ws://100.98.144.27:6768']
    })

    expect(withEndpoints.success).toBe(true)
  })

  it('accepts a sync from a build that publishes no addresses', () => {
    expect(parseFor('hostMesh.sync', SYNC_REQUEST).success).toBe(true)
  })

  it('still refuses an unknown key, so a typo cannot ride along', () => {
    expect(
      parseFor('hostMesh.sync', { ...SYNC_REQUEST, endpoint: ['ws://host:6768'] }).success
    ).toBe(false)
  })

  it('bounds the address list to what a pairing row can hold', () => {
    const tooMany = Array.from({ length: 5 }, (_unused, index) => `ws://host-${index}:6768`)

    expect(parseFor('hostMesh.sync', { ...SYNC_REQUEST, endpoints: tooMany }).success).toBe(false)
  })
})
