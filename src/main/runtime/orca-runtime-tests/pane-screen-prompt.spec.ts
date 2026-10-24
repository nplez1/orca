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
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toMatchObject({
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
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.reason).toBe('agent-approval-prompt')
    runtime.onPtyData(
      'pty-screen',
      Array.from({ length: 14 }, (_, index) => `  step ${index + 1}: reading the diff\r\n`).join(
        ''
      ),
      1_100
    )
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toBeNull()
  })

  it('answers null for a pane showing ordinary output', async () => {
    const { runtime, paneKey } = await terminalRuntime()
    runtime.onPtyData('pty-screen', '  ✓ 12 tests passed\r\n  compiling…\r\n', 1_000)
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toBeNull()
  })

  it('answers undefined for a pane it cannot bind to a terminal', async () => {
    const { runtime } = await terminalRuntime()
    // Why undefined and not null: a pane with no terminal is "cannot see it", which the store must
    // not read as "no dialog" — and a closed pane must not throw into its deferred read either.
    expect(runtime.readPaneScreenPrompt('tab-gone:leaf-gone', 'copilot')).toBeUndefined()
  })
})

/** Pi's ask card, as the emulator's grid holds it: Pi-Bolt 1.0.0 `ask_user_question` over a 100x30
 *  PTY. The card is painted inside the alternate screen with cursor addressing, which is why the
 *  tail-text lane reads no dialog for pi and this lane reads the grid instead. The title it arrives
 *  with is pi's own claim (`π ! `), which is the half that keeps a transcript quote out. */
const PI_ASK_CARD = [
  ' Ask Colour',
  '  Colour',
  ' Which colour do you prefer most?',
  ' ❯ 1. Blue',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel · Ctrl+] to collapse',
  ''
].join('\r\n')

const PI_NEEDS_INPUT_TITLE = '\x1b]0;\u03c0 ! worker\x07'
const PI_WORKING_TITLE = '\x1b]0;\u03c0 - worker\x07'

async function piTerminalRuntime() {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-screen' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'pi', title: 'worker' })
  const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))
  // Why the drain: the grid is parsed off the write chain, so a read taken in the same tick as the
  // bytes is a grid behind - production reads are a timer apart, a test is not.
  const flush = async (): Promise<void> => {
    await runtime['headlessTerminals'].get('pty-screen')?.writeChain
  }
  return { runtime, paneKey, flush }
}

describe('the ask card a pi pane is holding', () => {
  it('reads the card from the rendered grid', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData('pty-screen', PI_NEEDS_INPUT_TITLE + PI_ASK_CARD, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toMatchObject({
      reason: 'agent-interactive-prompt',
      // Why the flag: the pane's own marker outranks the gained stamp in the store's reader.
      current: true
    })
  })

  it('reads no card from output that merely quotes the footer while the pane works', async () => {
    // Why: pi prints its own footer when it narrates about a card, and a diff of this very file
    // would otherwise put a working pane on Needs You for as long as the line stayed on screen.
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData(
      'pty-screen',
      `${PI_WORKING_TITLE}$ rg "Esc to cancel"\r\n${PI_ASK_CARD}`,
      1_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeNull()
  })

  it('stops reading the card once the grid no longer holds it', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData('pty-screen', PI_NEEDS_INPUT_TITLE + PI_ASK_CARD, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).not.toBeNull()
    runtime.onPtyData('pty-screen', '\x1b[2J\x1b[H  \u2713 12 tests passed\r\n', 2_000)
    await flush()
    // Why null and not undefined: the pane withdrew the claim, which is the evidence that ends the
    // wait - unlike a grid or title it cannot read, which must hold.
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeNull()
  })

  it('claims no wait for a dialog whose wording pi does not paint on a card', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData(
      'pty-screen',
      `${PI_NEEDS_INPUT_TITLE} Do you trust this workspace?\r\n Press enter to confirm\r\n`,
      1_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeNull()
  })
})
