import { describe, expect, it } from 'vitest'
import { actsForOwner, ownerAsPerson, threadActsFor } from './bot-acts-for'

describe('the owner as a person', () => {
  it('is still the owner every check reads, and names them where a surface can', () => {
    const owner = ownerAsPerson({ userId: 'nathanp', name: 'nathanp' })

    expect(owner).toMatchObject({ kind: 'person', source: 'local', role: 'owner' })
    expect(owner.name).toBe('nathanp')
    expect(actsForOwner([owner])).toBe(true)
    expect(threadActsFor([owner])).toBe('owner')
  })

  it('leaves a teammate a member, never the owner', () => {
    const teammate = { ...ownerAsPerson({ userId: 'sam' }), role: 'member' as const }

    expect(actsForOwner([teammate])).toBe(false)
    expect(actsForOwner([ownerAsPerson({ userId: 'nathanp' }), teammate])).toBe(false)
  })

  it('carries no name when the surface knows only an id', () => {
    expect(ownerAsPerson({ userId: 'nathanp' })).not.toHaveProperty('name')
  })
})
