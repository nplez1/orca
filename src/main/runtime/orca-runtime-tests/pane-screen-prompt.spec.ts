import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_PATH,
  expectStablePaneKeyEnv,
  spawnedPtyEnv,
  store
} from '../orca-runtime-test-fixtures.spec'

/** The visible lines of Copilot's approval dialog from `__fixtures__/copilot-command-prompt`, which
 *  prefixes each captured row with the box's `│` gutter. */
const APPROVAL_DIALOG = [
  ' Do you want to run this command?',
  ' ❯ 1. Yes',
  '   2. No, and tell Copilot what to do differently (Esc to stop)',
  ' ↑/↓ to navigate · enter to select · esc to cancel'
].join('\r\n')

async function terminalRuntime(
  deps: { onPaneScreenPromptGained?: (paneKey: string) => void } = {}
) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-screen' })
  const runtime = new OrcaRuntimeService(store, undefined, deps)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: 'copilot',
    title: 'worker'
  })
  const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))
  return { runtime, paneKey }
}

describe('the screen prompt a pane is holding', () => {
  it('reads the approval dialog out of the pane it belongs to', async () => {
    const { runtime, paneKey } = await terminalRuntime()
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    expect(runtime.readPaneScreenPrompt(paneKey)).toMatchObject({
      reason: 'agent-approval-prompt',
      // Why the stamp: a dialog gained before the turn opened is discarded by the store's reader, so
      // the scan's own clock has to reach it — a null one would silently disable that check.
      since: 1_000
    })
  })

  it('reports the moment a dialog appears, through the host dep the store binds', async () => {
    // Why: this is the path a dialog painted long after the agent's last hook arrives through; it is
    // wired in the runtime constructor, not by the caller, so the dep must fire on its own.
    const gained: string[] = []
    const { runtime, paneKey } = await terminalRuntime({
      onPaneScreenPromptGained: (key) => gained.push(key)
    })
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    // Why a tick: the report is deferred out of the byte path, so the scan can record the state it
    // compared before the store repaints a row.
    await new Promise((resolve) => setImmediate(resolve))
    expect(gained).toEqual([paneKey])
  })

  it('stops reading a dialog its later output has pushed out of the window', async () => {
    // Why: the copilot fixtures' own note says an answered dialog is protected by the CLI erasing it
    // rather than by the matcher, so enough later output pushes it out of the window the layer reads.
    // That, and not a hook, is what ends the wait in practice.
    const { runtime, paneKey } = await terminalRuntime()
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    expect(runtime.readPaneScreenPrompt(paneKey)?.reason).toBe('agent-approval-prompt')
    runtime.onPtyData(
      'pty-screen',
      Array.from({ length: 14 }, (_, index) => `  step ${index + 1}: reading the diff\r\n`).join(
        ''
      ),
      1_100
    )
    expect(runtime.readPaneScreenPrompt(paneKey)).toBeNull()
  })

  it('answers null for a pane showing ordinary output', async () => {
    const { runtime, paneKey } = await terminalRuntime()
    runtime.onPtyData('pty-screen', '  ✓ 12 tests passed\r\n  compiling…\r\n', 1_000)
    expect(runtime.readPaneScreenPrompt(paneKey)).toBeNull()
  })

  it('answers undefined for a pane it cannot bind to a terminal', async () => {
    const { runtime } = await terminalRuntime()
    // Why undefined and not null: a pane with no terminal is "cannot see it", which the store must
    // not read as "no dialog" — and a closed pane must not throw into its deferred read either.
    expect(runtime.readPaneScreenPrompt('tab-gone:leaf-gone')).toBeUndefined()
  })
})
