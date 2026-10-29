/**
 * Why its own file: installer-utils.test.ts sits at its max-lines budget, and this is the one part of
 * the matcher that turns on what is installed beside this build (see official-orca-profile.ts).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from './installer-utils'

// A resolved `.orca` path in this user's home belongs to an official install once one has run.
const ownHomeLegacyCommand = join(homedir(), '.orca', 'agent-hooks', 'claude-hook.sh')

describe('createManagedCommandMatcher and the pre-rename home directory', () => {
  it('leaves it alone while an official install may own it', () => {
    const withoutOfficialInstall = createManagedCommandMatcher('claude-hook.sh', {
      sweepLegacyHomeDirectory: false
    })
    expect(withoutOfficialInstall(ownHomeLegacyCommand)).toBe(false)
    // A remote host's `.orca` registration is still ours; only this home is ambiguous.
    expect(withoutOfficialInstall('/bin/sh "/home/remote/.orca/agent-hooks/claude-hook.sh"')).toBe(
      true
    )
    expect(withoutOfficialInstall('${HOME-}/.orca/agent-hooks/claude-hook.sh')).toBe(true)
  })

  it('sweeps it when no official install is present', () => {
    const withoutOfficialInstall = createManagedCommandMatcher('claude-hook.sh', {
      sweepLegacyHomeDirectory: true
    })
    expect(withoutOfficialInstall(ownHomeLegacyCommand)).toBe(true)
  })
})
