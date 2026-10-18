import { describe, expect, it } from 'vitest'
import { getJiraPrioritySeverity, getJiraPrioritySurfaceTone } from './task-page-jira-priority-tone'

function priority(name: string): { id: string; name: string } {
  return { id: `priority-${name}`, name }
}

describe('Jira priority severity', () => {
  it('maps each standard tier vocabulary onto a severity', () => {
    expect(getJiraPrioritySeverity(priority('Blocker'))).toBe('blocker')
    expect(getJiraPrioritySeverity(priority('Highest'))).toBe('blocker')
    expect(getJiraPrioritySeverity(priority('Critical'))).toBe('critical')
    expect(getJiraPrioritySeverity(priority('Major'))).toBe('major')
    expect(getJiraPrioritySeverity(priority('High'))).toBe('major')
  })

  it('leaves the low tiers and unknown schemes uncoloured', () => {
    for (const name of [
      'Medium',
      'Normal',
      'Low',
      'Minor',
      'Lowest',
      'Trivial',
      'P0',
      'Severity A'
    ]) {
      expect(getJiraPrioritySeverity(priority(name))).toBe('standard')
    }
    expect(getJiraPrioritySeverity(undefined)).toBe('standard')
    expect(getJiraPrioritySeverity(null)).toBe('standard')
  })

  it('matches case and surrounding whitespace', () => {
    expect(getJiraPrioritySeverity(priority('  bLoCkEr  '))).toBe('blocker')
  })

  it('keeps the blocker-only surface wash on the same palette as the chip', () => {
    expect(getJiraPrioritySurfaceTone(priority('Blocker')).base).toBe('bg-jira-priority-high/10')
    expect(getJiraPrioritySurfaceTone(priority('Critical')).base).toBe('')
    expect(getJiraPrioritySurfaceTone(priority('Major')).base).toBe('')
    expect(getJiraPrioritySurfaceTone(undefined).base).toBe('')
  })
})

describe('Jira priority task surface', () => {
  it('washes the whole surface only for a blocker, keeping the wash on hover and selection', () => {
    expect(getJiraPrioritySurfaceTone(priority('Blocker'))).toEqual({
      base: 'bg-jira-priority-high/10',
      border: 'border-jira-priority-high/40',
      hover: 'hover:bg-jira-priority-high/15',
      selected: 'bg-jira-priority-high/15'
    })
  })

  it('leaves every other tier on the plain surface and the generic accent states', () => {
    for (const name of ['Critical', 'Major', 'Medium', 'Minor', 'Trivial']) {
      expect(getJiraPrioritySurfaceTone(priority(name))).toEqual({
        base: '',
        border: '',
        hover: 'hover:bg-accent',
        selected: 'bg-accent'
      })
    }
  })
})
