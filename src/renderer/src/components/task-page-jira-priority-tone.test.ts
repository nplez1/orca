import { describe, expect, it } from 'vitest'
import {
  getJiraPrioritySeverity,
  getJiraPrioritySurfaceTone,
  getJiraPriorityTone
} from './task-page-jira-priority-tone'

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

  it('shares the red chip between blocker and critical, and gives major the orange one', () => {
    expect(getJiraPriorityTone(priority('Blocker'))).toContain('text-severity-blocker')
    expect(getJiraPriorityTone(priority('Critical'))).toContain('text-severity-blocker')
    expect(getJiraPriorityTone(priority('Major'))).toContain('text-severity-major')
    // The wash is the only thing separating a blocker from a critical, so the chips match.
    expect(getJiraPriorityTone(priority('Blocker'))).toBe(getJiraPriorityTone(priority('Critical')))
    expect(getJiraPriorityTone(priority('Minor'))).toBe(
      'border-border/50 bg-muted/40 text-muted-foreground'
    )
    expect(getJiraPriorityTone(undefined)).toBe(
      'border-border/50 bg-muted/40 text-muted-foreground'
    )
  })
})

describe('Jira priority task surface', () => {
  it('washes the whole surface only for a blocker, keeping the wash on hover and selection', () => {
    expect(getJiraPrioritySurfaceTone(priority('Blocker'))).toEqual({
      base: 'bg-severity-blocker/10',
      border: 'border-severity-blocker/40',
      hover: 'hover:bg-severity-blocker/15',
      selected: 'bg-severity-blocker/15'
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
