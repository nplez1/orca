import { describe, expect, it } from 'vitest'
import { actsForOwner, ownerAsPerson, threadActsFor, OWNER_ACTS_FOR } from './bot-acts-for'

describe('the owner as a person', () => {
  it('is still the owner every check reads, and names them where a surface can', () => {
    const owner = ownerAsPerson({ userId: 'nathanp', name: 'nathanp' })

    expect(owner).toMatchObject({ kind: 'person', source: 'local', role: 'owner' })
    expect(owner.name).toBe('nathanp')
    expect(actsForOwner([owner])).toBe(true)
    expect(threadActsFor([owner])).toBe('owner')
  })

  it('keeps a cloud turn on the bare owner, which knows no more than that', () => {
    expect(OWNER_ACTS_FOR).toEqual([{ kind: 'owner' }])
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
