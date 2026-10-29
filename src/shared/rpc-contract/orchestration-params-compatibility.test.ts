import { describe, expect, it } from 'vitest'
import { AskParams, CheckParams } from './orchestration-params'

/** The fork installs its CLI as `orca-np`, and the packaged Windows launcher can name the dev
 *  build too. A host that validates either field against a shorter list refuses the whole
 *  orchestration call, so both lists are contract, not detail. */
describe('orchestration peer-CLI names', () => {
  it.each(['orca', 'orca-ide', 'orca-dev', 'orca-np', 'orca-np-dev'])(
    'accepts %s on check',
    (compatibilityCliCommand) => {
      expect(
        CheckParams.safeParse({ terminal: 'term_worker', compatibilityCliCommand }).success
      ).toBe(true)
    }
  )

  it.each(['orca', 'orca-ide', 'orca-np', 'orca-np-dev'])(
    'accepts %s on the packaged Windows launcher field',
    (compatibilityWindowsCommand) => {
      expect(
        AskParams.safeParse({ question: 'Ship it?', compatibilityWindowsCommand }).success
      ).toBe(true)
    }
  )

  it('refuses a name outside the set', () => {
    expect(
      CheckParams.safeParse({ terminal: 'term_worker', compatibilityCliCommand: 'orca-beta' })
        .success
    ).toBe(false)
    // `orca-dev` is a dev CLI name, not a packaged Windows launcher name.
    expect(
      AskParams.safeParse({ question: 'Ship it?', compatibilityWindowsCommand: 'orca-dev' }).success
    ).toBe(false)
  })
})
