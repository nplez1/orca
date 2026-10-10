// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JiraIcon } from './JiraIcon'
import { LinearIcon } from './LinearIcon'

afterEach(cleanup)

/** Why this asserts the attributes and not a computed style: an inline <svg> with
 *  a viewBox and no width/height resolves against the 300x150 default object size,
 *  which is what rendered the Jira tab mark enormous in the activity bar. The
 *  attribute is the contract the callers rely on. */
describe('provider mark icons', () => {
  it.each([
    ['JiraIcon', JiraIcon],
    ['LinearIcon', LinearIcon]
  ])('%s renders at the size the caller asks for', (_name, Icon) => {
    const { container } = render(<Icon size={16} />)
    const svg = container.querySelector('svg')

    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
  })

  it.each([
    ['JiraIcon', JiraIcon],
    ['LinearIcon', LinearIcon]
  ])('%s defaults to the shared 24px icon size', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')

    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })
})
