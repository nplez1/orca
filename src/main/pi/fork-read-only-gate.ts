// A look-around run on Pi is held by two layers: `--tools read,grep,find,ls,bash --no-mcp` at launch,
// and this extension, which lets those four through and refuses anything else unless the read-only
// policy allows the bash call. Pi runs the extension in its own process, so it carries its own copy of
// the policy; the unit test runs it against `lookAroundCommandRefusal` for every read path the policy
// declares and pins the text it mirrors - `bot-look-around-policy.ts`'s decision and the
// `bot-look-around-shell-syntax.ts` module it reads its words and refusals from - so a change to either
// trips a red here.
import { LOOK_AROUND_REFUSAL } from '../bots/bot-look-around-policy'
import { writePiExtensionFile } from './rpc/launch/pi-extension-file'

export const PI_LOOK_AROUND_GATE_EXTENSION_FILE = 'orca-look-around-gate.ts'

/** Writes the gate for a look launch and returns its path; async, so nothing blocks the main thread. */
export function writePiReadOnlyGate(directory: string): Promise<string> {
  return writePiExtensionFile(
    directory,
    PI_LOOK_AROUND_GATE_EXTENSION_FILE,
    PI_LOOK_AROUND_GATE_EXTENSION_SOURCE
  )
}

/**
 * The extension Pi loads beside a look run, written by the resolution layer like the bot-tools one.
 * Self-contained on purpose: it must not import Orca, which is not on Pi's module path once packaged,
 * so the policy it applies is written out here in full - the shell-syntax rules first, then the tables
 * and the decision, in the order the two mirrored modules state them.
 */
export const PI_LOOK_AROUND_GATE_EXTENSION_SOURCE = `// Written by Orca for one look-around run. Refuses anything but a read; do not edit.
const REFUSAL = ${JSON.stringify(LOOK_AROUND_REFUSAL)}

// Mirrored from src/main/bots/bot-look-around-shell-syntax.ts: how a command reads as shell text.
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+-]+$/
const CURLY_QUOTE_OR_DASH = /[\\u2013-\\u201E]/
const INVISIBLE = /[\\0-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\x85\\u2028\\u2029\\uFEFF]/

function syntaxRefusal(what) {
  return (
    'Looking around runs plain reads, chained only with ;, && or || and ending at most in 2>&1: ' +
    what +
    " isn't allowed. Use plain words or 'single quotes'."
  )
}

function characterRefusal(command) {
  if (INVISIBLE.test(command)) {
    return syntaxRefusal('a control or invisible character')
  }
  const curly = CURLY_QUOTE_OR_DASH.exec(command)
  return curly
    ? syntaxRefusal('a curly quote or dash ("' + curly[0] + '"; use straight \\' and -)')
    : null
}

function trimBlanks(text) {
  return text.replace(/^[ \\t]+|[ \\t]+$/g, '')
}

function words(command) {
  const out = []
  let consumed = ''
  for (const match of command.matchAll(/(?<=^|[ \\t])(?:'([^'\\n\\r]*)'|([^\\s']+))(?=[ \\t]|$)/g)) {
    const [whole, quoted, plain] = match
    if (plain !== undefined && (!PLAIN_WORD.test(plain) || plain.startsWith('='))) {
      return null
    }
    out.push(
      quoted === undefined ? { text: plain ?? '', quoted: false } : { text: quoted, quoted: true }
    )
    consumed += whole
  }
  const gaps = (text) => text.replace(/[ \\t]/g, '')
  return gaps(consumed) === gaps(command) ? out : null
}

function chainParts(command) {
  const parts = []
  let start = 0
  let quoted = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "'") {
      quoted = !quoted
    } else if (!quoted && (char === ';' || ('&|'.includes(char) && command[index + 1] === char))) {
      parts.push(trimBlanks(command.slice(start, index)))
      index += char === ';' ? 0 : 1
      start = index + 1
    }
  }
  parts.push(trimBlanks(command.slice(start)))
  return parts
}

const TRAILING_REDIRECT = { bash: /[ \\t]+2>(?:&1|\\/dev\\/null)$/, powershell: /[ \\t]+2>&1$/ }

const SHELL_WRAPPER =
  /^(?:(?:\\/usr|\\/usr\\/local|\\/opt\\/homebrew)?\\/bin\\/)?(?:ba|z)?sh[ \\t]+-l?c[ \\t]+((?:'[^']*'(?!')|"(?:[^"\\\\$\`!]|\\\\["\\\\])*"|\\\\')+)$/
const LITERAL_RUN = /'([^']*)'|"((?:[^"\\\\]|\\\\.)*)"|\\\\(')/g

function unwrapShell(command) {
  const trimmed = trimBlanks(command)
  const wrapped = SHELL_WRAPPER.exec(trimmed)
  return wrapped
    ? wrapped[1].replace(
        LITERAL_RUN,
        (_, single, double, quote) => single ?? double?.replace(/\\\\(.)/g, '$1') ?? quote
      )
    : trimmed
}

const BOT_CLI_PREFIX = '"\${ORCA_CLI_COMMAND:-orca}" '

const SHELL_SYNTAX = [
  [/\\n|\\r/, 'a second line', false],
  [/"/, "double quotes (use 'single quotes')", false],
  [/\\|/, 'a pipe', true],
  [/\\d*(?:>>?|<)(?:&\\d*-?)?/, 'a redirect', true],
  [/&/, 'running in the background', true],
  [/\\$\\(?|\`/, 'expansion', true]
]

function shellSyntaxRefusal(command) {
  const unquoted = command.replace(/'[^'\\n\\r]*'/g, "''")
  for (const [pattern, name, show] of SHELL_SYNTAX) {
    const match = pattern.exec(unquoted)
    if (match) {
      return syntaxRefusal(show ? name + ' ("' + match[0] + '")' : name)
    }
  }
  const word = unquoted.split(/[ \\t]+/).find((part) => part && !PLAIN_WORD.test(part))
  return syntaxRefusal('"' + (word ?? command) + '"')
}

function powerShellWordRefusal(parts) {
  for (const { text, quoted } of parts) {
    if (quoted && text.includes('"')) {
      return syntaxRefusal("a double quote inside 'single quotes' in PowerShell")
    }
    if (quoted && (text === '' || text.endsWith('\\\\'))) {
      return syntaxRefusal("'" + text + "' (empty or ending in \\\\) in PowerShell")
    }
    if (!quoted && text.startsWith('@')) {
      return syntaxRefusal('"' + text + '" (splatting in PowerShell)')
    }
    if (!quoted && text.includes(',')) {
      return syntaxRefusal(
        '"' + text + '" (an array in PowerShell; repeat the flag per value, as in --json a --json b)'
      )
    }
  }
  return null
}

function windowsLauncherWordRefusal(parts) {
  for (const { text, quoted } of parts) {
    if (quoted && /[&|<>^%!]/.test(text)) {
      return syntaxRefusal("'" + text + "' (cmd.exe reads & | < > ^ % ! even in quotes on Windows)")
    }
    if (quoted && /[,;]/.test(text) && !/[ \\t]/.test(text)) {
      return syntaxRefusal(
        "'" + text + "' (cmd.exe splits a value at , or ; when it has no space; repeat the flag per value, as in --json a --json b)"
      )
    }
  }
  return null
}

// Mirrored from src/main/bots/bot-look-around-policy.ts: the reads, what they refuse, and the decision.
const READ_COMMANDS = {
  orca: [
    ['slack', 'find'],
    ['slack', 'read'],
    ['slack', 'check'],
    ['bot', 'connectors'],
    ['bot', 'list'],
    ['bot', 'chats'],
    ['bot', 'item', 'list'],
    ['bot', 'item', 'show'],
    ['bot', 'work', 'list'],
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

function ghStaysOnGitHub(args) {
  return args.every((word, index) => {
    const previous = args[index - 1]
    if (previous === '-R' || previous === '--repo') {
      return GITHUB_REPO.test(word)
    }
    if (word.startsWith('--repo=')) {
      return GITHUB_REPO.test(word.slice('--repo='.length))
    }
    if (
      word === '--web' ||
      word.startsWith('--web=') ||
      (/^-[^-]*[Rw]/.test(word) && word !== '-R')
    ) {
      return false
    }
    return !word.includes('://') || GITHUB_URL.test(word)
  })
}

const GIT_BRANCH_LISTING = new Set(['-a', '-r', '--all', '--remotes'])

function notARead(what) {
  return 'Looking around can only read: ' + what + '. Suggest this as a next step instead.'
}

function partRefusal(part, shell) {
  const read = part.replace(TRAILING_REDIRECT[shell], '')
  const inner =
    shell === 'bash' && read.startsWith(BOT_CLI_PREFIX)
      ? 'orca ' + read.slice(BOT_CLI_PREFIX.length)
      : read
  const parsed = words(inner)
  if (!parsed) {
    return shellSyntaxRefusal(inner)
  }
  const wordRefusal =
    (shell === 'powershell' ? powerShellWordRefusal(parsed) : null) ??
    (shell === 'powershell' || process.platform === 'win32'
      ? windowsLauncherWordRefusal(parsed)
      : null)
  if (wordRefusal !== null) {
    return wordRefusal
  }
  if (parsed.length === 0) {
    return notARead('an empty command runs nothing')
  }
  const [program, ...rest] = parsed.map((word) => word.text)
  const path = Object.hasOwn(READ_COMMANDS, program)
    ? READ_COMMANDS[program].find((candidate) =>
        candidate.every((word, index) => rest[index] === word)
      )
    : undefined
  if (!path) {
    const end = rest.findIndex((word) => !/^[a-z][a-z-]*$/.test(word))
    const subcommand = rest.slice(0, Math.min(3, end === -1 ? 3 : end))
    return notARead('"' + [program, ...subcommand].join(' ') + " isn't a read")
  }
  const name = [program, ...path].join(' ')
  const args = rest.slice(path.length)
  const refused = args.find((word) => REFUSED_ARGUMENTS[program]?.(word) === true)
  if (refused !== undefined) {
    return notARead('"' + refused + '" makes "' + name + '" more than a read')
  }
  if (program === 'gh' && !ghStaysOnGitHub(args)) {
    return notARead('"' + name + '" may only read github.com, without --web')
  }
  if (path[0] === 'branch' && !args.every((word) => GIT_BRANCH_LISTING.has(word))) {
    return notARead('"git branch" may only list branches')
  }
  return null
}

/** Why a shell command is not reads the run may make, or null when it is: each part of a chain is
 *  held to the same rules, and one refused part refuses the whole command. */
function lookAroundCommandRefusal(command, shell = 'bash') {
  const unwrapped = shell === 'bash' ? unwrapShell(command) : trimBlanks(command)
  const characters = characterRefusal(unwrapped)
  if (characters !== null) {
    return characters
  }
  const parts = chainParts(unwrapped)
  for (const part of parts) {
    const refusal = partRefusal(part, shell)
    if (refusal !== null) {
      return parts.length > 1 ? refusal + ' Refused part: ' + (part || '(empty)') : refusal
    }
  }
  return null
}

function allowed(command, shell = 'bash') {
  return lookAroundCommandRefusal(command, shell) === null
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
