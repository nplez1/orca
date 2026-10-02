import { describe, expect, it } from 'vitest'
import { pageOwnsTitlebar } from './page-owned-titlebar'

describe('pageOwnsTitlebar', () => {
  it('claims the top edge for pages that render their own first row', () => {
    expect(pageOwnsTitlebar('automations')).toBe(true)
    expect(pageOwnsTitlebar('artifacts')).toBe(true)
    expect(pageOwnsTitlebar('dashboard')).toBe(true)
    expect(pageOwnsTitlebar('tasks')).toBe(true)
  })

  it('leaves the stacked titlebar to the other sidebar views', () => {
    expect(pageOwnsTitlebar('terminal')).toBe(false)
    expect(pageOwnsTitlebar('skills')).toBe(false)
    expect(pageOwnsTitlebar('settings')).toBe(false)
  })
})
