import { describe, expect, it } from 'vitest'
import { AI_PROMPTS, AI_PROMPTS_NOT_YET_CENTRALIZED } from './index'

// The point of this directory is that a prompt cannot hide in the module that calls it. This
// pins the list itself: every entry names what it is for, where it is used, and builds text.
describe('AI prompt index', () => {
  it('describes every prompt it lists', () => {
    for (const entry of AI_PROMPTS) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/)
      expect(entry.purpose.length).toBeGreaterThan(10)
      expect(entry.usedBy.length).toBeGreaterThan(5)
      expect(typeof entry.buildPrompt).toBe('function')
    }
  })

  it('lists each prompt once', () => {
    const ids = AI_PROMPTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // "One place" is a claim about the present; the stragglers are named rather than implied, so
  // the list shrinks deliberately instead of being forgotten.
  it('names the prompts that still live elsewhere', () => {
    expect(AI_PROMPTS_NOT_YET_CENTRALIZED.length).toBeGreaterThan(0)
    for (const path of AI_PROMPTS_NOT_YET_CENTRALIZED) {
      expect(path).toMatch(/^[a-z-]+(\/[a-z0-9-]+)*\.ts$/)
    }
  })
})
