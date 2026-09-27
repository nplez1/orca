import { describe, expect, it } from 'vitest'
import {
  isWorkspacePathIndexEnabled,
  WORKSPACE_PATH_INDEX_DISABLE_ENV
} from './workspace-path-index-feature-switch'

describe('workspace path-index feature switch', () => {
  it('enables the index by default for internal and development builds', () => {
    expect(isWorkspacePathIndexEnabled({})).toBe(true)
  })

  it('disables indexing only when the established ORCA_DISABLE switch is explicitly set', () => {
    expect(isWorkspacePathIndexEnabled({ [WORKSPACE_PATH_INDEX_DISABLE_ENV]: '1' })).toBe(false)
    expect(isWorkspacePathIndexEnabled({ [WORKSPACE_PATH_INDEX_DISABLE_ENV]: '0' })).toBe(true)
    expect(isWorkspacePathIndexEnabled({ [WORKSPACE_PATH_INDEX_DISABLE_ENV]: 'true' })).toBe(true)
  })
})
