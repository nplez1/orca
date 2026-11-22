import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOK_AROUND_REFUSAL, lookAroundCommandAllowed } from '../bots/bot-look-around-policy'
import { PI_LOOK_AROUND_GATE_EXTENSION_SOURCE } from './fork-read-only-gate'

type Handler = (event: unknown) => unknown

/** The extension as Pi loads it: evaluated here, so the test drives the artifact and not a copy. */
function gate(): { toolCall: Handler; userBash: Handler } {
  const loaded: unknown = new Function(
    PI_LOOK_AROUND_GATE_EXTENSION_SOURCE.replace('export default ', 'return ')
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

/**
 * Every read path the policy declares, one entry per `READ_COMMANDS` row, in its order. A path added
 * or removed upstream trips the pin below; a path misspelled in the extension's copy fails here.
 */
const READ_PATHS = [
  'orca slack find',
  'orca slack read',
  'orca slack check',
  'orca bot connectors',
  'orca bot list',
  'orca linear issue',
  'orca linear search',
  'orca linear list-issues',
  'orca bot suggest',
  'orca automations list',
  'orca automations show',
  'orca repo list',
  'orca worktree ps',
  'orca worktree list',
  'gh pr view',
  'gh pr list',
  'gh pr checks',
  'gh pr diff',
  'gh issue view',
  'gh issue list',
  'gh run view',
  'gh run list',
  'git log',
  'git show',
  'git diff',
  'git status',
  'git branch',
  'git rev-parse',
  'git ls-files'
] as const

/** One argument each program's `REFUSED_ARGUMENTS` rule turns away, for the refused half. */
const REFUSED_ARGUMENT: Record<string, string> = {
  orca: '--join general',
  gh: '--method POST',
  git: '--output=/tmp/x'
}

const refusedFor = (path: string): string => `${path} ${REFUSED_ARGUMENT[path.split(' ')[0]]}`

/**
 * One case per alternative in each program's `REFUSED_ARGUMENTS` rule and in `ghStaysOnGitHub`'s
 * `-w`/`-Rvalue` bundle, each on a path that is otherwise allowed — so the argument is what refuses it,
 * not the path lookup. A re-mirror that loses an alternative goes red here.
 */
const REFUSED_ARGUMENT_CASES = [
  ['orca slack find', '--join general'],
  ['orca slack find', '--download general'],
  ['orca slack find', '--out general'],
  ['orca slack find', '--offer general'],
  ['gh pr view', '--method POST'],
  ['gh pr view', '--input body.json'],
  ['gh pr view', '--field title'],
  ['gh pr view', '--raw-field title'],
  ['gh pr view', '-XPOST'],
  ['gh pr view', '-if'],
  ['gh pr view', '-F'],
  ['gh pr view', '-w'],
  ['gh pr view', '-Rother/repo'],
  ['git log', '-c core.pager=less'],
  ['git log', '-o /tmp/out'],
  ['git log', '--output=/tmp/out'],
  ['git log', '--exec=cat'],
  ['git log', '--ext-diff'],
  ['git log', '--textconv'],
  ['git log', '--upload-pack=cat'],
  ['git log', '--receive-pack=cat'],
  ['git log', ':src/main/a.ts']
] as const

/** Commands that reach a program or a shell feature the policy has no read path for. */
const REFUSED_COMMANDS = [
  'gh pr merge 12',
  'gh pr merge --squash',
  'gh api -XPOST /repos/a/b/merges',
  'gh pr list --repo=evil.com/a/b',
  'gh pr list -Rhost/o/r',
  'gh pr list --web',
  'gh pr view 1 --web',
  'gh pr view https://example.com/x',
  'git push',
  'git commit -m x',
  'git branch -D main',
  'git branch main',
  'git show :src/main/a.ts',
  'git -c core.pager=less log',
  // A tilde revision is outside the policy's plain-word set, so the word splitter refuses it.
  'git diff HEAD~1',
  'orca slack join general',
  'orca slack download general',
  'FOO=1 gh pr list',
  'gh pr list; rm -rf /',
  'git show | tee /tmp/out',
  'rm -rf /',
  'echo "hello"',
  '',
  '   ',
  "unbalanced 'quote"
]

/**
 * Reads with the shapes a bot actually writes: the preamble's own CLI prefix, a shell wrapper, a
 * repository, a URL, and arguments after the path.
 */
const OTHER_READS = [
  '"${ORCA_CLI_COMMAND:-orca}" worktree ps',
  '"${ORCA_CLI_COMMAND:-orca}" slack find standup',
  'bash -lc \'"${ORCA_CLI_COMMAND:-orca}" worktree ps\'',
  "bash -lc 'git status'",
  "zsh -lc 'gh pr checks'",
  'gh issue list --repo nplez1/orca',
  'gh pr view --repo other/repo',
  'gh pr view https://github.com/nplez1/orca/pull/1',
  'git branch -a',
  'git log --oneline -5',
  'orca slack read --channel general'
]

const POLICY_FILE = fileURLToPath(new URL('../bots/bot-look-around-policy.ts', import.meta.url))

/** The policy text the extension mirrors: its tables, its word splitter and the decision itself. */
function mirroredPolicy(): string {
  const source = readFileSync(POLICY_FILE, 'utf8')
  const start = source.indexOf('const READ_COMMANDS')
  const end = source.indexOf('/** Claude tools that only read')
  if (start === -1 || end <= start) {
    throw new Error('bot-look-around-policy.ts no longer reads as this test expects')
  }
  return source.slice(start, end)
}

/**
 * The one thing a command corpus cannot prove: that upstream did not *tighten* the policy. A path
 * removed, or a refused argument added, after a security report would leave the extension's copy
 * loose while every case above still agreed.
 */
const MIRRORED_POLICY_SHA256 = '5cddd7eb690de9cb99f9ab75c39585b389c6bde4d69b66704d8620dd9af2b2b6'

describe('the look-around gate Pi loads', () => {
  it('pins the policy text it mirrors', () => {
    expect(
      createHash('sha256').update(mirroredPolicy()).digest('hex'),
      'upstream changed the look-around policy; re-mirror fork-read-only-gate.ts and update this hash'
    ).toBe(MIRRORED_POLICY_SHA256)
  })

  it.each(READ_PATHS)('%s is a read in both copies', async (path) => {
    expect(lookAroundCommandAllowed(path)).toBe(true)
    expect(await blocks(path)).toBe(false)
  })

  it.each(READ_PATHS)('%s loses the argument its program refuses', async (path) => {
    expect(lookAroundCommandAllowed(refusedFor(path))).toBe(false)
    expect(await blocks(refusedFor(path))).toBe(true)
  })

  it.each(REFUSED_ARGUMENT_CASES)(
    '%s refuses %j while the path alone is a read',
    async (path, argument) => {
      expect(lookAroundCommandAllowed(path)).toBe(true)
      expect(lookAroundCommandAllowed(`${path} ${argument}`)).toBe(false)
      expect(await blocks(`${path} ${argument}`)).toBe(true)
    }
  )

  it.each(OTHER_READS)('%j is read exactly as the policy reads it', async (command) => {
    expect(lookAroundCommandAllowed(command)).toBe(true)
    expect(await blocks(command)).toBe(false)
  })

  it.each(REFUSED_COMMANDS)('%j is refused exactly as the policy refuses it', async (command) => {
    expect(lookAroundCommandAllowed(command)).toBe(false)
    expect(await blocks(command)).toBe(true)
  })

  it('leaves the tools the launch already bounded alone', async () => {
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      expect(await gate().toolCall({ toolName, input: {} })).toBeUndefined()
    }
  })

  it('refuses a tool neither layer bounded, and a call it cannot name', async () => {
    for (const toolName of ['write', 'edit', 'Agent', 'subagent', 'code', 'bash_output']) {
      expect(await gate().toolCall({ toolName, input: {} })).toEqual({
        block: true,
        reason: LOOK_AROUND_REFUSAL
      })
    }
    expect(await gate().toolCall({})).toEqual({ block: true, reason: LOOK_AROUND_REFUSAL })
    expect(await gate().toolCall(undefined)).toEqual({ block: true, reason: LOOK_AROUND_REFUSAL })
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
