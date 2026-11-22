// A look-around run on Pi is held by two layers: `--tools read,grep,find,ls,bash --no-mcp` at launch,
// and this extension, which lets those four through and refuses anything else unless the read-only
// policy allows the bash call. Pi runs the extension in its own process, so it carries its own copy of
// the policy; the unit test runs it against `lookAroundCommandAllowed` for every read path the policy
// declares and pins the policy text it mirrors, so a tightening upstream trips a red here.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { LOOK_AROUND_REFUSAL } from '../bots/bot-look-around-policy'

export const PI_LOOK_AROUND_GATE_EXTENSION_FILE = 'orca-look-around-gate.ts'

/** Where Pi's per-chat extensions live, under userData because the launch builder gets no state dir. */
export function piReadOnlyGateDirectory(): string {
  return join(getAppEnvironment().getPath('userData'), 'pi-native-chat')
}

export function piReadOnlyGatePath(): string {
  return join(piReadOnlyGateDirectory(), PI_LOOK_AROUND_GATE_EXTENSION_FILE)
}

/**
 * The extension Pi loads beside a look run. Self-contained on purpose: it must not import Orca, which
 * is not on Pi's module path once packaged, so the policy it applies is written out here in full.
 */
export function piReadOnlyGateSource(): string {
  return `// Written by Orca for one look-around run. Refuses anything but a read; do not edit.
const REFUSAL = ${JSON.stringify(LOOK_AROUND_REFUSAL)}

const READ_COMMANDS = {
  orca: [
    ['slack', 'find'],
    ['slack', 'read'],
    ['slack', 'check'],
    ['bot', 'connectors'],
    ['bot', 'list'],
    ['linear', 'issue'],
    ['linear', 'search'],
    ['linear', 'list-issues'],
    ['bot', 'suggest'],
    ['automations', 'list'],
    ['automations', 'show'],
    ['repo', 'list'],
    ['worktree', 'ps'],
    ['worktree', 'list']
  ],
  gh: [
    ['pr', 'view'],
    ['pr', 'list'],
    ['pr', 'checks'],
    ['pr', 'diff'],
    ['issue', 'view'],
    ['issue', 'list'],
    ['run', 'view'],
    ['run', 'list']
  ],
  git: [['log'], ['show'], ['diff'], ['status'], ['branch'], ['rev-parse'], ['ls-files']]
}

const REFUSED_ARGUMENTS = {
  orca: (word) => /^--(join|download|out|offer)/.test(word),
  gh: (word) => /^--(method|input|field|raw-field)/.test(word) || /^-[^-]*[XfF]/.test(word),
  git: (word) =>
    word.startsWith('-c') ||
    /^-[^-]*o/.test(word) ||
    /^--(output|exec|ext-diff|textconv|upload-pack|receive-pack)/.test(word) ||
    word.startsWith(':')
}

const GITHUB_REPO = /^(?:github\\.com\\/)?[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+$/
const GITHUB_URL = /^https:\\/\\/github\\.com\\//
const GIT_BRANCH_LISTING = new Set(['-a', '-r', '--all', '--remotes'])
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+-]+$/
const BOT_CLI_PREFIX = '"\${ORCA_CLI_COMMAND:-orca}" '

function ghStaysOnGitHub(args) {
  return args.every((word, index) => {
    const previous = args[index - 1]
    if (previous === '-R' || previous === '--repo') {
      return GITHUB_REPO.test(word)
    }
    if (word.startsWith('--repo=')) {
      return GITHUB_REPO.test(word.slice('--repo='.length))
    }
    if (word === '--web' || (/^-[^-]*[Rw]/.test(word) && word !== '-R')) {
      return false
    }
    return !word.includes('://') || GITHUB_URL.test(word)
  })
}

function words(command) {
  const out = []
  let consumed = ''
  for (const match of command.matchAll(/(?<=^|[ \\t])(?:'([^'\\n\\r]*)'|([^\\s']+))(?=[ \\t]|$)/g)) {
    const [whole, quoted, plain] = match
    if (plain !== undefined && (!PLAIN_WORD.test(plain) || plain.startsWith('='))) {
      return null
    }
    out.push(quoted !== undefined ? quoted : plain !== undefined ? plain : '')
    consumed += whole
  }
  const gaps = (text) => text.replace(/[ \\t]/g, '')
  return gaps(consumed) === gaps(command) ? out : null
}

function unwrapShell(command) {
  const wrapped = /^(?:\\S*\\/)?(?:ba|z)?sh\\s+-l?c\\s+'((?:[^']|'\\\\'')*)'$/.exec(command.trim())
  return wrapped ? wrapped[1].replace(/'\\\\''/g, "'") : command.trim()
}

/** Whether a shell command is one read a look-around run may make. */
function allowed(command) {
  const unwrapped = unwrapShell(command)
  const inner = unwrapped.startsWith(BOT_CLI_PREFIX)
    ? 'orca ' + unwrapped.slice(BOT_CLI_PREFIX.length)
    : unwrapped
  const parts = words(inner)
  if (!parts || parts.length === 0) {
    return false
  }
  const [program, ...rest] = parts
  const paths = Object.hasOwn(READ_COMMANDS, program) ? READ_COMMANDS[program] : undefined
  const path = paths && paths.find((candidate) => candidate.every((word, index) => rest[index] === word))
  if (!path) {
    return false
  }
  const args = rest.slice(path.length)
  const refused = Object.hasOwn(REFUSED_ARGUMENTS, program) ? REFUSED_ARGUMENTS[program] : undefined
  if (refused && args.some((word) => refused(word) === true)) {
    return false
  }
  if (program === 'gh' && !ghStaysOnGitHub(args)) {
    return false
  }
  return path[0] !== 'branch' || args.every((word) => GIT_BRANCH_LISTING.has(word))
}

const BOUNDED_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export default function (pi) {
  pi.on('tool_call', async (event) => {
    const toolName = event && typeof event.toolName === 'string' ? event.toolName : null
    if (toolName !== null && BOUNDED_TOOLS.has(toolName)) {
      return undefined
    }
    // --tools bounds those four; bash is held to the policy, and anything else - an extension's own
    // tool, a subagent - is bounded by neither layer, so it is refused.
    const command =
      toolName === 'bash' && event.input && typeof event.input.command === 'string'
        ? event.input.command
        : null
    return command !== null && allowed(command) ? undefined : { block: true, reason: REFUSAL }
  })
  // Nobody types in a look run, but a command that arrives that way is held to the same policy.
  pi.on('user_bash', async (event) => {
    const command = event && typeof event.command === 'string' ? event.command : null
    if (command !== null && allowed(command)) {
      return undefined
    }
    return { result: { output: REFUSAL, exitCode: 1, cancelled: true, truncated: false } }
  })
}
`
}

/** The extension arguments for a limited run: the path is stable, the content is what may change. */
export function piReadOnlyGateArgs(): string[] {
  return ['--extension', writePiReadOnlyGateSync()]
}

function writePiReadOnlyGateSync(): string {
  const directory = piReadOnlyGateDirectory()
  const path = piReadOnlyGatePath()
  const source = piReadOnlyGateSource()
  const current = (): string | null => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  if (current() === source) {
    return path
  }
  // Pi exits when an extension fails to load, so a concurrent launch must never read a partial file.
  mkdirSync(directory, { recursive: true })
  const staged = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(staged, source)
    renameSync(staged, path)
  } catch (error) {
    rmSync(staged, { force: true })
    // Windows refuses to replace a file Pi holds open; if it already holds this source, use it.
    if (current() === source) {
      return path
    }
    throw error
  }
  return path
}
