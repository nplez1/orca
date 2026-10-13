/**
 * Copilot CLI's blocking prompts, taken from captured PTY transcripts of CLI 1.0.97
 * (`__fixtures__/copilot-permission-prompt.txt`, `__fixtures__/copilot-question-prompt.txt`; the
 * raw recordings, escapes intact, are the source these visible lines were read from).
 *
 * The screen is the only witness. Copilot's hooks carry no "a prompt is up" event: a
 * `permission_prompt` also fires for the requests the CLI approves itself (measured: 3,611
 * assisted to 831 asked), and `ask_user` reaches Orca only as a postToolUse, after the answer. So
 * these anchors are what let a Copilot pane show the question instead of a spinner.
 */

import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

describe("Copilot's blocking prompts, from captured transcripts", () => {
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
})
