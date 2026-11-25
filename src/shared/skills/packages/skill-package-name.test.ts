import { readFileSync } from 'node:fs'
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

  // Why: bots/bot-package reaches the renderer, where Vite stubs node builtins with a throwing proxy.
  it('imports nothing, so renderer-reachable contracts can use it', () => {
    const source = readFileSync(new URL('./skill-package-name.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
  })
})
