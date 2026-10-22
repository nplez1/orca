import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { stripComments } from '../../shared/source-scan/source-tree-scan'

const src = join(__dirname, '../..')

/**
 * Every place a Claude login could be written from: accounts, usage, launch, hooks, the CLI, the
 * relay and the generated shell scripts. Plan §9 lists these; credential checks run on all of them.
 */
const credentialRoots: readonly (string | { root: string; only: RegExp })[] = [
  'main/claude-accounts',
  // Other providers there refresh their own logins; only Claude's usage is in scope.
  { root: 'main/rate-limits', only: /[\\/]claude[^\\/]*\.ts$/ },
  'main/claude',
  'main/native-chat',
  'main/ipc/pty',
  'main/daemon',
  'main/providers',
  'main/macos-keychain',
  'cli',
  'relay',
  'shared'
]

/**
 * Only noncredential profile surfaces may persist bytes, and each only with the primitives it
 * uses today; a new primitive in one of them is a review, not a silent pass.
 */
const fsAllowances: Record<string, readonly string[]> = {
  'claude-accounts/claude-profile-history.ts': [
    'mkdirSync',
    'renameSync',
    'rmdirSync',
    'symlinkSync',
    'unlinkSync'
  ],
  'claude-accounts/claude-profile-paths.ts': ['mkdirSync', 'writeFileAtomically'],
  // The which-account file.
  'claude-accounts/claude-profile-router.ts': ['mkdirSync', 'rmSync', 'writeFileAtomically'],
  // Removing an account deletes its folder, links first.
  'claude-accounts/claude-account-folder.ts': ['rmSync', 'rmdirSync', 'unlinkSync'],
  // Not a file: a pasted sign-in code goes to the login process's stdin.
  'claude-accounts/claude-command-process.ts': ['write'],
  'claude-accounts/claude-profile-prompt-history.ts': [
    'appendFileSync',
    'linkSync',
    'openSync',
    'renameSync',
    'rmSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileSync',
    'writeFileAtomically'
  ],
  'claude-accounts/claude-profile-provisioning.ts': [
    'publishFileWithoutOverwrite',
    'rmSync',
    'writeFileSync'
  ],
  'claude-accounts/claude-profile-sharing.ts': [
    'mkdirSync',
    'rmdirSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileAtomically'
  ],
  // The BROWSER stand-in a hidden sign-in hands its link through; holds no login.
  'claude-accounts/claude-sign-in-browser.ts': ['rm', 'writeFile'],
  // The guest helper answers the host on stdout.
  'claude-accounts/claude-profile-wsl-entry.ts': ['write'],
  // The one surface that writes a login back: the token exchange persists the rotated pair.
  'claude-accounts/claude-oauth-credential-store.ts': [
    'writeFileAtomically',
    'writeFileAtomicallyIfUnchanged',
    'writeFileRotation'
  ]
}
const mutation =
  /^(?:write(?:File|Json|Sync|v|.*Credentials|.*Keychain)?$|write(?:File|Json)|appendFile|copyFile|cp(?:Sync)?$|rename(?:Sync)?$|unlink(?:Sync)?$|rm(?:dir)?(?:Sync)?$|truncate(?:Sync)?$|createWriteStream|symlink(?:Sync)?$|link(?:Sync)?$|chmod(?:Sync)?$|mkdir(?:Sync)?$|mkdtemp(?:Sync)?$|open(?:Sync)?$|delete.*Keychain)/

function persistencePrimitives(text: string): string[] {
  const found = new Set<string>()
  // Import-side names survive aliases, including destructuring and wrapped helper calls.
  for (const match of text.matchAll(/\b([a-zA-Z_$][\w$]*)\s*(?=\(|as\s|[:,}])/g)) {
    if (mutation.test(match[1])) {
      found.add(match[1])
    }
  }
  return [...found]
}

const WRITE_CALL =
  /\b(?:write\w*|append\w*|copy\w*|cp(?:Sync)?|rename\w*|link\w*|symlink\w*|createWriteStream)\s*\(/g
// The one runner that takes `security` argv from its callers; each caller must spell the verb.
// It also owns the write verb, so no caller has to spell `add-generic-password` itself.
const SECURITY_RUNNER = 'main/macos-keychain/generic-password.ts'
// Removing an account deletes the Keychain items Claude made for its folder; nothing else deletes.
const KEYCHAIN_DELETE_OWNER = 'main/claude-accounts/claude-account-folder.ts'
/**
 * The one file allowed to exchange a stored refresh token and write the rotated pair back.
 *
 * A Claude refresh token is single-use, so persisting the rotation is part of the exchange, not a
 * separate credential write: backing out the write would strand the login Orca just rotated. The
 * exchange only ever runs against the source it was read from, and only after the usage endpoint
 * refused that token.
 */
const TOKEN_REFRESH_OWNER = 'main/claude-accounts/claude-oauth-token-refresh.ts'
/** The one file that writes a rotated login back to the item or file it came from. */
const CREDENTIAL_STORE_OWNER = 'main/claude-accounts/claude-oauth-credential-store.ts'
/** The store's only Keychain writes: the shared helper, and the routine that applies it. */
const CREDENTIAL_STORE_KEYCHAIN_WRITES = new Set(['writeKeychainPassword', 'writeKeychainRotation'])
/** The runner defines these three and nothing else; a fourth helper is a review. */
const SECURITY_RUNNER_KEYCHAIN_HELPERS = new Set([
  'writeKeychainPassword',
  'readKeychainPassword',
  'deleteKeychainPassword'
])
/**
 * Only the usage fetch may start an exchange, and only the exchange may write the result. Both are
 * ordinary exported code, so the census below reads the whole source tree: a timer or a background
 * sweep reaching either one would spend a single-use refresh token for no reason.
 */
const CREDENTIAL_EXCHANGE_SYMBOL = 'refreshClaudeOAuthCredentials'
const CREDENTIAL_ROTATION_SYMBOL = 'writeClaudeOAuthCredentialRotation'
const CREDENTIAL_EXCHANGE_OWNERS = new Set([
  'main/rate-limits/claude-active-usage-fetch.ts',
  TOKEN_REFRESH_OWNER
])
const CREDENTIAL_ROTATION_OWNERS = new Set([TOKEN_REFRESH_OWNER, CREDENTIAL_STORE_OWNER])

/** Names bound, directly or through another such name, to the credentials file's path. */
function credentialFileNames(text: string): Set<string> {
  const declarations: { name: string; init: string }[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const declared = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (!declared) {
      return
    }
    const indent = declared[1].length
    let end = index + 1
    while (end < lines.length && /^\s*$|^\s+/.test(lines[end])) {
      const lead = /^\s*/.exec(lines[end])?.[0].length ?? 0
      if (lines[end].trim() && lead <= indent && !/^\s*[)\]}]/.test(lines[end])) {
        break
      }
      end += 1
    }
    declarations.push({ name: declared[2], init: lines.slice(index, end).join('\n') })
  })
  const names = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const { name, init } of declarations) {
      const tainted =
        init.includes('.credentials.json') ||
        [...names].some((other) => new RegExp(`\\b${other}\\b`).test(init.replace(name, '')))
      if (tainted && !names.has(name)) {
        names.add(name)
        changed = true
      }
    }
  }
  return names
}

/** Credential writes refused everywhere scanned, whatever form the call takes. */
function credentialMutations(text: string, file = ''): string[] {
  const found: string[] = []
  // A `security` launch whose verb is not spelled out could be a write, so only the runner may
  // forward argv, and its callers must spell the verb.
  if (
    (file !== SECURITY_RUNNER &&
      /\b(?:exec(?:File)?(?:Sync|Async)?|spawn(?:Sync)?|runProcess|spawnProcess)\s*\(\s*['"`]security['"`]\s*,\s*(?!\[\s*['"])/.test(
        text
      )) ||
    /\bprogram\s*:\s*['"`]security['"`]\s*,\s*args\s*:\s*(?!\[\s*['"])/.test(text) ||
    /(?<!function\s)\bexecSecurityCommand\s*\(\s*(?!\[\s*['"])/.test(text)
  ) {
    found.push('keychain command with a computed verb')
  }
  // A name bound to the credentials file that reaches a write, anywhere in the same file.
  const names = credentialFileNames(text)
  for (const call of text.matchAll(WRITE_CALL)) {
    const args = text.slice(call.index + call[0].length, call.index + call[0].length + 300)
    if ([...names].some((name) => new RegExp(`\\b${name}\\b`).test(args))) {
      found.push('credentials file write through a name')
      break
    }
  }
  // Argv (`['add-generic-password', …]`) and shell (`security add-generic-password`) forms.
  if (
    (file !== SECURITY_RUNNER && /add-generic-password/.test(text)) ||
    (file !== KEYCHAIN_DELETE_OWNER && /delete-generic-password/.test(text))
  ) {
    found.push('keychain write')
  }
  // Only the runner may name a keychain helper, and the token exchange may call exactly the write
  // it needs: `writeKeychainPassword`. Anything else is a review, not a silent pass.
  for (const [helper] of text.matchAll(/\b(?:write|delete|store|save)\w*Keychain\w*\b/g)) {
    if (file === SECURITY_RUNNER && SECURITY_RUNNER_KEYCHAIN_HELPERS.has(helper)) {
      continue
    }
    if (file === CREDENTIAL_STORE_OWNER && CREDENTIAL_STORE_KEYCHAIN_WRITES.has(helper)) {
      continue
    }
    found.push('keychain helper')
    break
  }
  if (file !== TOKEN_REFRESH_OWNER && /oauth\/token|grant_type|\brefresh_token\b/.test(text)) {
    found.push('token refresh')
  }
  // A statement that names the credentials file together with anything that writes, copies,
  // moves or opens it for writing (TS calls and generated shell alike).
  for (const statement of text.split(/;|\n\s*\n/)) {
    if (
      statement.includes('.credentials.json') &&
      /\b(?:write\w*|append\w*|copy\w*|cp(?:Sync)?|rename\w*|link\w*|symlink\w*|createWriteStream|mv|tee|install)\b|\bopen(?:Sync)?\s*\([\s\S]{0,200}?,\s*['"`](?:w|a|r\+|wx|ax)|>\s*["'$]/.test(
        statement
      )
    ) {
      found.push('credentials file write')
    }
  }
  return found
}

function files(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory()
      ? entry.name === 'node_modules' || entry.name === '__fixtures__'
        ? []
        : files(file)
      : /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/.test(entry.name) &&
          !/\.test\.|\.spec\.|test-harness|harness\.ts|test-fixtures|test-utils/.test(entry.name)
        ? [file]
        : []
  })
}

it('keeps every Claude credential writer removed, in every form and on every launch path', () => {
  const violations = credentialRoots
    .flatMap((entry) => {
      const { root, only } = typeof entry === 'string' ? { root: entry, only: null } : entry
      const dir = join(src, root)
      const found = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? files(dir) : []
      return only ? found.filter((file) => only.test(file)) : found
    })
    .flatMap((file) =>
      credentialMutations(
        stripComments(readFileSync(file, 'utf8')),
        relative(src, file).replaceAll('\\', '/')
      ).map((kind) => `${relative(src, file)}: ${kind}`)
    )
  expect(violations).toEqual([])
})

it('confines filesystem persistence in accounts and usage to named profile surfaces', () => {
  const main = join(src, 'main')
  const candidates = [
    ...files(__dirname),
    ...files(join(main, 'rate-limits')).filter((file) => /\/claude[^/]*\.ts$/.test(file))
  ]
  const violations = candidates.flatMap((file) => {
    const name = relative(main, file).replaceAll('\\', '/')
    const allowed = new Set(fsAllowances[name] ?? [])
    return persistencePrimitives(stripComments(readFileSync(file, 'utf8')))
      .filter((primitive) => !allowed.has(primitive))
      .map((primitive) => `${name}: ${primitive}`)
  })
  expect(violations).toEqual([])
  const cli = readFileSync(join(main, '../cli/handlers/account.ts'), 'utf8')
  expect(cli).not.toMatch(/Keychain|orca-account-add-claude|addClaudeFromConfigDir/)
  const auth = readFileSync(join(__dirname, 'runtime-auth-service.ts'), 'utf8')
  expect(auth).not.toMatch(/extends ClaudeRuntimeAuth|snapshot|credentialsJson|readBack/i)
})

it.each([
  "import { writeFile as save } from 'node:fs/promises'; save(path, token)",
  "import * as fs from 'node:fs'; const save = () => fs.writeFileSync(path, token)",
  "import { writeFileAtomically as persist } from '../codex-accounts/fs-utils'; persist(path, token)",
  'fs.copyFile(source, destination)',
  'fs.symlink(credentialPath, destination)',
  "const fd = openSync(join(dir, 'x'), 'w'); writeSync(fd, token)",
  'await fs.promises.cp(a, b)',
  'fs.cpSync(a, b, { recursive: true })'
])('mutation control: the filesystem census rejects %s', (source) => {
  expect(persistencePrimitives(source).length).toBeGreaterThan(0)
})

it.each([
  'security add-generic-password -s Claude -w token',
  "await execFileAsync('security', ['add-generic-password', '-U', '-s', service, '-w', token])",
  "execFileSync('security', ['delete-generic-password', '-s', 'Claude Code-credentials'])",
  "import { writeKeychainPassword as persist } from '../macos-keychain/generic-password'; persist(service, user, token)",
  "const fd = openSync(join(dir, '.credentials.json'), 'w'); writeSync(fd, token)",
  "await fs.promises.cp(join(a, '.credentials.json'), join(b, '.credentials.json'))",
  "copyFileSync(join(from, '.credentials.json'), join(home, '.credentials.json'))",
  "const script = 'cp source .credentials.json'",
  'const script = `printf %s "$token" > "$HOME/.claude/.credentials.json"`',
  "fetch('https://api.anthropic.com/v1/oauth/token')",
  "body: JSON.stringify({ grant_type: 'refresh_token' })",
  "execFile('security', [['add', 'generic', 'password'].join('-'), '-s', service])",
  "spawn('security', verbArgs)",
  'execSecurityCommand(args)',
  "const CREDENTIALS_FILE = '.credentials.json'\n\ncopyFileSync(join(from, CREDENTIALS_FILE), join(to, CREDENTIALS_FILE))",
  "const name = '.credentials.json'\nfunction save(dir) {\n  const target = join(dir, name)\n\n  writeFileSync(target, token)\n}"
])('mutation control: the credential check rejects %s', (source) => {
  expect(credentialMutations(source).length).toBeGreaterThan(0)
})

it.each([
  "const file = await readFile(join(home, '.credentials.json'), 'utf8')",
  "readKeychainPassword('Claude Code-credentials', user)",
  "execSecurityCommand(['find-generic-password', '-s', service, '-w'])",
  "const file = join(home, '.credentials.json')\nconst raw = await readFile(file, 'utf8')"
])('the credential check leaves a read alone: %s', (source) => {
  expect(credentialMutations(source)).toEqual([])
})

it('lets only account removal delete a Keychain item, and only the store update one', () => {
  const remove = "execSecurityCommand(['delete-generic-password', '-s', service])"
  expect(credentialMutations(remove, KEYCHAIN_DELETE_OWNER)).toEqual([])
  expect(credentialMutations(remove, 'main/claude-accounts/service.ts')).not.toEqual([])
  expect(
    credentialMutations(
      "execSecurityCommand(['add-generic-password', '-s', service])",
      KEYCHAIN_DELETE_OWNER
    )
  ).not.toEqual([])
})

it('scopes the one allowed token exchange to the refresh owner and nowhere else', () => {
  const exchange =
    "await getMainHttpClient().fetch('https://platform.claude.com/v1/oauth/token', { body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token }) })"
  expect(credentialMutations(exchange, TOKEN_REFRESH_OWNER)).toEqual([])
  expect(
    credentialMutations(exchange, 'main/rate-limits/claude-active-usage-fetch.ts')
  ).not.toEqual([])
  const helper = 'await writeKeychainPassword(service, account, contents)'
  expect(credentialMutations(helper, CREDENTIAL_STORE_OWNER)).toEqual([])
  expect(credentialMutations(helper, SECURITY_RUNNER)).toEqual([])
  expect(credentialMutations(helper, 'main/rate-limits/claude-fetcher.ts')).not.toEqual([])
  // The store may make the two writes it needs and nothing else.
  expect(
    credentialMutations('await writeKeychainRotation(item, token)', CREDENTIAL_STORE_OWNER)
  ).toEqual([])
  expect(
    credentialMutations('await deleteKeychainPassword(service, account)', CREDENTIAL_STORE_OWNER)
  ).not.toEqual([])
  const argv = "execSecurityCommand(['add-generic-password', '-U', '-s', service, '-X', token])"
  expect(credentialMutations(argv, SECURITY_RUNNER)).toEqual([])
  expect(credentialMutations(argv, TOKEN_REFRESH_OWNER)).not.toEqual([])
})

it('lets only the usage fetch start an exchange, and only the exchange write its result', () => {
  const source = join(__dirname, '../..')
  const violations = files(source).flatMap((file) => {
    const name = relative(source, file).replaceAll('\\', '/')
    const text = stripComments(readFileSync(file, 'utf8'))
    return [
      ...(text.includes(CREDENTIAL_EXCHANGE_SYMBOL) && !CREDENTIAL_EXCHANGE_OWNERS.has(name)
        ? [`${name}: starts a credential exchange`]
        : []),
      ...(text.includes(CREDENTIAL_ROTATION_SYMBOL) && !CREDENTIAL_ROTATION_OWNERS.has(name)
        ? [`${name}: writes a credential rotation`]
        : [])
    ]
  })
  expect(violations).toEqual([])
})
