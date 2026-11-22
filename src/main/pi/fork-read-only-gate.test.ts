import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOOK_AROUND_REFUSAL, lookAroundCommandAllowed } from '../bots/bot-look-around-policy'
import {
  PI_LOOK_AROUND_GATE_EXTENSION_FILE,
  piReadOnlyGatePath,
  piReadOnlyGateSource,
  piReadOnlyGateArgs
} from './fork-read-only-gate'

type Handler = (event: unknown) => unknown

/** The extension as Pi loads it: evaluated here, so the test drives the artifact and not a copy. */
function gate(): { toolCall: Handler; userBash: Handler } {
  const loaded: unknown = new Function(
    piReadOnlyGateSource().replace('export default ', 'return ')
  )()
  if (typeof loaded !== 'function') {
    throw new Error('The generated gate extension registers nothing')
  }
  const handlers: Record<string, Handler> = {}
  loaded({
    on: (name: string, handler: Handler) => {
      handlers[name] = handler
    }
  })
  return { toolCall: handlers.tool_call, userBash: handlers.user_bash }
}

const toolCall = (command: unknown): Promise<unknown> =>
  Promise.resolve(gate().toolCall({ toolName: 'bash', input: { command } }))

const blocks = async (command: string): Promise<boolean> =>
  (await gate().toolCall({ toolName: 'bash', input: { command } })) !== undefined

/** Every command the policy has an answer for, so the extension and Orca cannot drift apart. */
const CORPUS = [
  'gh pr checks',
  'gh pr view 12',
  'gh issue list --repo nplez1/orca',
  'gh run view 44',
  'git status',
  'git log --oneline -5',
  'git diff HEAD~1',
  'git branch -a',
  'orca worktree ps',
  'orca bot connectors',
  'orca slack read --channel general',
  'orca linear issue ENG-12',
  "bash -lc 'git status'",
  "zsh -lc 'gh pr checks'",
  'gh pr merge 12',
  'gh pr merge --squash',
  'git push',
  'git commit -m x',
  'git branch -D main',
  'git branch main',
  'rm -rf /',
  'gh api -XPOST /repos/a/b/merges',
  'gh pr view --repo other/repo',
  'gh pr list --web',
  'gh pr view 1 --web',
  'git diff --output=/tmp/x',
  'git -c core.pager=less log',
  'orca slack join general',
  'orca slack download general',
  'FOO=1 gh pr list',
  'gh pr list; rm -rf /',
  'git show | tee /tmp/out',
  'echo "hello"',
  '',
  '   ',
  "unbalanced 'quote"
]

describe('the look-around gate Pi loads', () => {
  it.each(CORPUS.map((command) => [command] as const))(
    'answers %j exactly as the read-only policy does',
    async (command) => {
      expect(await blocks(command)).toBe(!lookAroundCommandAllowed(command))
    }
  )

  it('leaves the tools the launch already bounded alone', async () => {
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      expect(await gate().toolCall({ toolName, input: {} })).toBeUndefined()
    }
  })

  it('refuses a bash call whose command it cannot read, and says why', async () => {
    expect(await gate().toolCall({ toolName: 'bash', input: {} })).toEqual({
      block: true,
      reason: LOOK_AROUND_REFUSAL
    })
    expect(await gate().toolCall({ toolName: 'bash', input: { command: 42 } })).toEqual({
      block: true,
      reason: LOOK_AROUND_REFUSAL
    })
    expect(await toolCall('git status')).toBeUndefined()
    expect(await toolCall('git push')).toEqual({ block: true, reason: LOOK_AROUND_REFUSAL })
  })

  it('holds a command typed with ! to the same policy', async () => {
    const { userBash } = gate()
    expect(await userBash({ command: 'git status' })).toBeUndefined()
    expect(await userBash({ command: 'git push' })).toEqual({
      result: { output: LOOK_AROUND_REFUSAL, exitCode: 1, cancelled: true, truncated: false }
    })
    expect(await userBash({})).toMatchObject({ result: { exitCode: 1 } })
  })
})

describe('the gate file a limited launch names', () => {
  it('writes the extension once and names it with --extension', () => {
    const args = piReadOnlyGateArgs()
    expect(args).toEqual(['--extension', piReadOnlyGatePath()])
    expect(piReadOnlyGatePath().endsWith(PI_LOOK_AROUND_GATE_EXTENSION_FILE)).toBe(true)
    expect(existsSync(piReadOnlyGatePath())).toBe(true)
    expect(readFileSync(piReadOnlyGatePath(), 'utf8')).toBe(piReadOnlyGateSource())
  })

  it('leaves the file untouched when it already holds the source', () => {
    const path = piReadOnlyGatePath()
    const before = readFileSync(path, 'utf8')
    expect(piReadOnlyGateArgs()).toEqual(['--extension', path])
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})
