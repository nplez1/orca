import { describe, expect, it } from 'vitest'
import { validateSkillPackageName } from './skill-package-name'

describe('validateSkillPackageName', () => {
  it('accepts lowercase letters, digits and dashes', () => {
    expect(() => validateSkillPackageName('release-notes-2')).not.toThrow()
  })

  it.each(['', 'Upper', '-leading', 'has_underscore', 'a'.repeat(65), 'con', 'lpt1'])(
    'rejects %j',
    (name) => {
      expect(() => validateSkillPackageName(name)).toThrow('skill-package-skill-name-invalid')
    }
  )
})
