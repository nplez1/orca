import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from '../../agent-hooks/server'
import { buildBody, postHookEvent } from '../../agent-hooks/server.test-fixtures'
import { wireScreenPromptReader } from '../../agent-hooks/server/server-screen-prompt-wiring'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { readRuntimeFixture } from '../agent-transcript-replay-test-harness'
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
    getSize: () => ({ cols: 120, rows: 40 }),
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: 'copilot',
    title: 'worker'
  })
  const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))
  const flush = async (): Promise<void> => {
    await runtime['headlessTerminals'].get('pty-screen')?.writeChain
  }
  return { runtime, paneKey, flush }
}

describe('the screen prompt a pane is holding', () => {
  it('detects the captured Copilot dialog after the tail loses it', async () => {
    const gained: string[] = []
    const { runtime, paneKey, flush } = await terminalRuntime({
      onPaneScreenPromptGained: (key) => gained.push(key)
    })
    const transcript = readRuntimeFixture('copilot-1-0-105-manual-approval')
    for (let offset = 0; offset < transcript.length; offset += 64) {
      runtime.onPtyData('pty-screen', transcript.slice(offset, offset + 64), Date.now())
    }
    await flush()
    await new Promise((resolve) => setImmediate(resolve))
    // Why two: the byte path and the tail scan each report the same appearance, and the store's
    // noteDialogGained tolerates a repeat. Pinned so neither reporter can silently stop firing.
    expect(gained).toEqual([paneKey, paneKey])
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toMatchObject({
      reason: 'agent-approval-prompt'
    })
  })

  it('publishes the captured dialog through the hook store and clears it after dismissal', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-copilot-screen-'))
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const { runtime, paneKey, flush } = await terminalRuntime({
        onPaneScreenPromptGained: (key) => server.noteScreenPromptGained(key)
      })
      wireScreenPromptReader(server, runtime)
      const tabId = paneKey.split(':')[0]
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'UserPromptSubmit', prompt: 'run a command' },
          { paneKey, tabId }
        ),
        '/hook/copilot'
      )
      await postHookEvent(
        server,
        buildBody({ hookName: 'permissionRequest', tool_name: 'bash' }, { paneKey, tabId }),
        '/hook/copilot'
      )
      const transcript = readRuntimeFixture('copilot-1-0-105-manual-approval')
      for (let offset = 0; offset < transcript.length; offset += 64) {
        runtime.onPtyData('pty-screen', transcript.slice(offset, offset + 64), Date.now())
      }
      await flush()
      await vi.waitFor(
        () => expect(server.getStatusSnapshotForPane(paneKey)[0]?.state).toBe('waiting'),
        { timeout: 4_000 }
      )
      runtime.onPtyData('pty-screen', '\u001b[2J\u001b[Hcommand running\r\n', Date.now())
      await flush()
      await vi.waitFor(
        () => expect(server.getStatusSnapshotForPane(paneKey)[0]?.state).toBe('working'),
        { timeout: 4_000 }
      )
    } finally {
      server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('stamps the dialog once, and restamps it after the wait is dropped', async () => {
    const { runtime, paneKey, flush } = await terminalRuntime()
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    await flush()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toMatchObject({
      reason: 'agent-approval-prompt',
      since: 2_000
    })
    // Why the same stamp: the store judges the row's turn clock against it, so a re-read of a dialog
    // that never left must not advance it.
    clock.mockReturnValue(9_000)
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.since).toBe(2_000)
    // Why a new stamp: the wait is over, so a second dialog must not inherit one that predates it.
    runtime.forgetPaneScreenPrompt(paneKey)
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.since).toBe(9_000)
    clock.mockRestore()
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
    expect(gained).toEqual([paneKey, paneKey])
  })

  it('reports once per run of candidate wording, not once per chunk', async () => {
    const gained: string[] = []
    const { runtime, paneKey } = await terminalRuntime({
      onPaneScreenPromptGained: (key) => gained.push(key)
    })
    // Why 12: it separates the dialog's two candidate phrases, so the latch clears between them and
    // arms a second report -- where a report per chunk would arm one for every chunk instead.
    for (let offset = 0; offset < APPROVAL_DIALOG.length; offset += 12) {
      runtime.onPtyData('pty-screen', APPROVAL_DIALOG.slice(offset, offset + 12), 1_000)
    }
    await new Promise((resolve) => setImmediate(resolve))
    // One report per run of candidate wording; the tail scan's own report is still on its timer.
    expect(gained).toEqual([paneKey, paneKey])
  })

  it('stops reading a dialog its later output has pushed out of the window', async () => {
    // Why: the copilot fixtures' own note says an answered dialog is protected by the CLI erasing it
    // rather than by the matcher, so enough later output pushes it out of the window the layer reads.
    // That, and not a hook, is what ends the wait in practice.
    const { runtime, paneKey, flush } = await terminalRuntime()
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.reason).toBe('agent-approval-prompt')
    runtime.onPtyData(
      'pty-screen',
      Array.from({ length: 14 }, (_, index) => `  step ${index + 1}: reading the diff\r\n`).join(
        ''
      ),
      1_100
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toBeNull()
  })

  it('treats a grid painted for another size as unreadable', async () => {
    const { runtime, paneKey, flush } = await terminalRuntime()
    runtime.onPtyData('pty-screen', APPROVAL_DIALOG, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.reason).toBe('agent-approval-prompt')
    const size = vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 80, rows: 24 })
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')).toBeUndefined()
    size.mockRestore()
    expect(runtime.readPaneScreenPrompt(paneKey, 'copilot')?.reason).toBe('agent-approval-prompt')
  })

  it('answers null for a pane showing ordinary output', async () => {
    const { runtime, paneKey, flush } = await terminalRuntime()
    runtime.onPtyData('pty-screen', '  ✓ 12 tests passed\r\n  compiling…\r\n', 1_000)
    await flush()
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
const PI_WORKING_TITLE = '\x1b]0;\u03c0 : worker\x07'
const PI_IDLE_TITLE = '\x1b]0;\u03c0 > worker\x07'

async function piTerminalRuntime(
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

  it('holds the wait while the pane still claims a card the grid no longer shows', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData('pty-screen', PI_NEEDS_INPUT_TITLE + PI_ASK_CARD, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).not.toBeNull()
    runtime.onPtyData('pty-screen', '\x1b[2J\x1b[H  \u2713 12 tests passed\r\n', 2_000)
    await flush()
    // Why undefined and not null: the pane's own marker still claims a dialog, so an emptied grid
    // is a card that was answered (the marker follows within the second), not evidence nobody is
    // waiting. Releasing here is how a collapsed or clipped card became a Working tab (#227).
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeUndefined()
  })

  it('ends the wait once the pane withdraws its own claim', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData('pty-screen', PI_NEEDS_INPUT_TITLE + PI_ASK_CARD, 1_000)
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).not.toBeNull()
    // Answered: the titlebar extension releases the marker, which is the positive evidence.
    runtime.onPtyData(
      'pty-screen',
      `${PI_IDLE_TITLE}\x1b[2J\x1b[H  \u2713 12 tests passed\r\n`,
      2_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeNull()
  })

  it('tells the store as soon as the pane claims a dialog', async () => {
    // Why: pi paints most dialogs with no hook of its own, and the store's only other on-gain cue is
    // the tail-text scan, which a card in the alternate screen never reaches. Without this the row
    // waits for the next hook post, which an unanswered dialog may never send (#228).
    const gained: string[] = []
    const { runtime, paneKey, flush } = await piTerminalRuntime({
      onPaneScreenPromptGained: (key) => gained.push(key)
    })
    runtime.onPtyData('pty-screen', PI_WORKING_TITLE + PI_ASK_CARD, 1_000)
    await flush()
    expect(gained).toEqual([])

    runtime.onPtyData('pty-screen', PI_NEEDS_INPUT_TITLE, 2_000)
    await flush()
    expect(gained).toEqual([paneKey])
  })

  it('holds the wait rather than releasing it on a footer it cannot read', async () => {
    // Why undefined and not null: the pane still claims a dialog with `π !`, and a footer this
    // reader has not learned is an unreadable grid - releasing there is a Working tab over a card
    // a person still has to answer (#227).
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData(
      'pty-screen',
      `${PI_NEEDS_INPUT_TITLE} Do you trust this workspace?\r\n Press enter to confirm\r\n`,
      1_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toBeUndefined()
  })

  it("recognises pi's own selector footer, which a permission gate paints", async () => {
    // Why: `ctx.ui.select` is what a pi approval gate, a plan review and the trust prompt use, and
    // its footer matched none of the ask card's anchors (#227).
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData(
      'pty-screen',
      `${PI_NEEDS_INPUT_TITLE} PROBE gate: run echo PROBEGATE-1?\r\n \u2191\u2193 navigate  enter select  escape/ctrl+c cancel\r\n`,
      1_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toMatchObject({
      reason: 'agent-interactive-prompt',
      current: true
    })
  })

  it('keeps the card readable when it is collapsed and expanded again', async () => {
    const { runtime, paneKey, flush } = await piTerminalRuntime()
    runtime.onPtyData(
      'pty-screen',
      `${PI_NEEDS_INPUT_TITLE} Ask Colour\r\n  Colour\r\n \u276f 1. Blue\r\n Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes \u00b7 Esc to cancel \u00b7 Ctrl+] to collapse\r\n`,
      1_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toMatchObject({ current: true })

    // Ctrl+]: the card keeps its cancel half and drops the accept half.
    runtime.onPtyData(
      'pty-screen',
      '\x1b[2J\x1b[H Ask Colour\r\n  Collapsed\r\n Ctrl+] to expand \u00b7 Esc to cancel\r\n',
      2_000
    )
    await flush()
    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toMatchObject({ current: true })
  })

  // Why both brands: the renderer rebrands a pi title to its owner label (`Pi ! …`), and a pi build
  // can paint that form itself. The whole lane gates on this classification, so the glyph must not
  // be what decides it.
  it.each([
    ['\u03c0', PI_NEEDS_INPUT_TITLE],
    ['Pi', '\x1b]0;Pi ! worker\x07']
  ])('reads the card under a %s-brand marker, and reports it', async (_brand, title) => {
    const gained: string[] = []
    const { runtime, paneKey, flush } = await piTerminalRuntime({
      onPaneScreenPromptGained: (key) => gained.push(key)
    })
    runtime.onPtyData('pty-screen', title + PI_ASK_CARD, 1_000)
    await flush()

    expect(runtime.readPaneScreenPrompt(paneKey, 'pi')).toMatchObject({
      reason: 'agent-interactive-prompt',
      current: true
    })
    expect(gained).toEqual([paneKey])
  })
})
