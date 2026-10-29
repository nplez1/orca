/**
 * Copilot CLI's blocking prompts, taken from captured PTY transcripts of CLI 1.0.97. The three
 * fixtures are the visible lines of those captures: `copilot-permission-prompt.txt` (URL access),
 * `copilot-command-prompt.txt` (shell command), `copilot-question-prompt.txt`.
 *
 * The 1.0.105 fixture retains raw PTY redraws; the older fixtures contain extracted visible lines.
 *
 * The screen is the only witness. Copilot's hooks carry no "a prompt is up" event: a
 * `permission_prompt` also fires for the requests the CLI approves itself (measured: 3,611
 * assisted to 831 asked), and `ask_user` reaches Orca only as a postToolUse, after the answer. So
 * these anchors are what let a Copilot pane show the question instead of a spinner.
 */

import { describe, expect, it } from 'vitest'
import {
  finalReplayFrame,
  readRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { CopilotScreenPromptGained } from './copilot-screen-prompt'

describe("Copilot's blocking prompts, from captured transcripts", () => {
  it('reads a live CLI 1.0.105 approval through the actual terminal redraw', async () => {
    const { ruledScreenLines, waitText } = await finalReplayFrame(
      'copilot-1-0-105-manual-approval',
      120,
      40
    )
    expect(detectTerminalWaitBlockedReason(ruledScreenLines.join('\n'))).toBe(
      'agent-approval-prompt'
    )
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })

  it('reads the captured approval in a narrow 60x20 terminal', async () => {
    const { ruledScreenLines } = await finalReplayFrame('copilot-1-0-105-narrow-approval', 60, 20)
    const detector = new CopilotScreenPromptGained()
    expect(detector.observe('pty', ruledScreenLines)?.reason).toBe('agent-approval-prompt')
  })

  it('keeps the first observation clock until the dialog disappears', async () => {
    const { ruledScreenLines } = await finalReplayFrame('copilot-1-0-105-manual-approval', 120, 40)
    const detector = new CopilotScreenPromptGained()
    expect(detector.observe('pty', ruledScreenLines, 100)?.since).toBe(100)
    expect(detector.observe('pty', ruledScreenLines, 200)?.since).toBe(100)
    expect(detector.observe('pty', ['command running'], 300)).toBeNull()
    expect(detector.observe('pty', ruledScreenLines, 400)?.since).toBe(400)
  })

  it('stamps a forgotten pane from its next sighting', async () => {
    const { ruledScreenLines } = await finalReplayFrame('copilot-1-0-105-manual-approval', 120, 40)
    const detector = new CopilotScreenPromptGained()
    expect(detector.observe('pty', ruledScreenLines, 100)?.since).toBe(100)
    detector.forget('pty')
    expect(detector.observe('pty', ruledScreenLines, 400)?.since).toBe(400)
  })

  it('observes a real approval until the user accepts it', async () => {
    const detector = new CopilotScreenPromptGained()
    let sawPrompt = false
    let last: ReturnType<CopilotScreenPromptGained['observe']> = null
    for await (const frame of replayTranscript(
      readRuntimeFixture('copilot-1-0-105-approved'),
      120,
      40
    )) {
      last = detector.observe('pty', frame.ruledScreenLines)
      sawPrompt ||= last?.reason === 'agent-approval-prompt'
    }
    expect(sawPrompt).toBe(true)
    expect(last).toBeNull()
  })

  it('never reports a dialog during a real assisted approval', async () => {
    const detector = new CopilotScreenPromptGained()
    for await (const frame of replayTranscript(
      readRuntimeFixture('copilot-1-0-105-assisted'),
      120,
      40
    )) {
      expect(detector.observe('pty', frame.ruledScreenLines)).toBeNull()
    }
  })

  it('reads the approval dialog as an approval prompt', () => {
    expect(detectTerminalWaitBlockedReason(readRuntimeFixture('copilot-permission-prompt'))).toBe(
      'agent-approval-prompt'
    )
  })

  it('reads a shell command approval, worded nothing like a URL approval', () => {
    expect(detectTerminalWaitBlockedReason(readRuntimeFixture('copilot-command-prompt'))).toBe(
      'agent-approval-prompt'
    )
  })

  it('reads an approval from its denial option alone, were the question worded a third way', () => {
    const thirdWording = [
      '│ Do you want to publish this package?',
      '│ ❯ 1. Yes',
      '│   2. No, and tell Copilot what to do differently (Esc to stop)',
      '│ ↑/↓ to navigate · enter to select · esc to cancel'
    ].join('\n')
    expect(detectTerminalWaitBlockedReason(thirdWording)).toBe('agent-approval-prompt')
  })

  it('reads the question dialog as an interactive prompt', () => {
    expect(detectTerminalWaitBlockedReason(readRuntimeFixture('copilot-question-prompt'))).toBe(
      'agent-interactive-prompt'
    )
  })

  it('reads the question dialog from its controls alone, were the header reworded', () => {
    const controlsOnly =
      'Which folder should I use?\n❯ alpha\n  beta\n ↑/↓ select · enter accept · ctrl+d decline · esc cancel'
    expect(detectTerminalWaitBlockedReason(controlsOnly)).toBe('agent-interactive-prompt')
  })

  it('never calls an assisted approval a prompt: the CLI decided, not the user', () => {
    // The marker the CLI prints when it approves on its own, from the same capture.
    const assisted = [
      'Approval checks (2)',
      '  │ ✓ Assisted Permissions approved URL (https://example.com/)',
      '    Human explicitly requested this bounded fetch from the identified URL.',
      '  └ ✓ Assisted Permissions approved shell command (curl)',
      '    Explicitly requested bounded fetch to the identified public URL.'
    ].join('\n')
    expect(detectTerminalWaitBlockedReason(assisted)).toBeNull()
  })

  it('keeps reading the folder-trust dialog the shared layer already covers', () => {
    const trust =
      '│ Confirm folder trust\n│ │ /private/tmp/cc-approval\n│ Do you trust the files in this folder?'
    expect(detectTerminalWaitBlockedReason(trust)).toBe('agent-trust-workspace')
  })

  it('stops reading a question the pane has scrolled well past', () => {
    const scrolled = `${readRuntimeFixture('copilot-question-prompt')}\n${'output line\n'.repeat(12)}`
    expect(detectTerminalWaitBlockedReason(scrolled)).toBeNull()
  })

  it('still reads a question with rows painted under its status line', () => {
    const longer = `${readRuntimeFixture('copilot-question-prompt')}\n model: gpt-6-luna\n cwd /tmp/cc-cap-q`
    expect(detectTerminalWaitBlockedReason(longer)).toBe('agent-interactive-prompt')
  })

  it('stops reading a dialog the CLI has erased from the screen', async () => {
    // Why the erase and not the tail window: this is what protects an answered dialog.
    const erased = `${readRuntimeFixture('copilot-question-prompt')}${'\u001b[2K\u001b[1A'.repeat(12)}`
    let ruledScreenLines: readonly string[] = []
    let waitText = ''
    for await (const frame of replayTranscript(erased, 120, 40)) {
      ruledScreenLines = frame.ruledScreenLines
      waitText = frame.waitText
    }
    expect(detectTerminalWaitBlockedReason(ruledScreenLines.join('\n'))).toBeNull()
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })
})
