/**
 * The zsh arm of `structured-session-cli-login-shell.test.ts`: Codex's own shell on macOS. Runs in
 * the real-shell lane, which installs zsh; the ordinary unit lane has none.
 */

import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLoginShellHarness,
  type LoginShellHarness
} from './structured-session-login-shell-test-harness'

// Why the binary, not the platform: a Linux runner is not win32 but ships no zsh, so the platform check
// alone ran this in the ordinary unit lane where the shell it drives does not exist.
describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
  'a structured session in a zsh login shell',
  () => {
    let harness: LoginShellHarness

    beforeEach(() => {
      harness = createLoginShellHarness()
    })

    afterEach(() => {
      harness.dispose()
    })

    it("resolves this app's CLI through ORCA_CLI_COMMAND in `zsh -lc`", async () => {
      // Positive control: the profile really does put the global install first for a bare name.
      expect(await harness.run({ program: '/bin/zsh', args: ['-lc', 'orca-np'] })).toBe('global')
      expect(await harness.run({ program: '/bin/zsh', args: ['-lc', '"$ORCA_CLI_COMMAND"'] })).toBe(
        'app'
      )
    })
  }
)
