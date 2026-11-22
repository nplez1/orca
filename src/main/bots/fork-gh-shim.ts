// The marker every bot-written GitHub body carries, appended by a `gh` the bot cannot skip: a fork
// shim first on the bot's PATH. Omission is the risk that matters — a forgotten marker wakes the bot
// on its own output — so the marker is written by code, never remembered by the model.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { botsRootFolder } from './bot-home'

/** The env key a bot's launch carries its shim folder in; `withBotLaunchToolsEnv` puts it on PATH. */
export const BOT_GH_SHIM_DIR_ENV = 'ORCA_BOT_GH_SHIM_DIR'

const MARKER_PREFIX = '<!-- orca-bot:'
const MARKER_PATTERN = /<!--\s*orca-bot:([^>]*?)\s*-->/u

/** The marker a body written as `botName` carries, invisible to anyone reading it rendered. A name is
 *  free text, so `>` and a doubled hyphen are taken out: one would break the read-back, the other ends
 *  the HTML comment and renders the rest. */
export function botGhMarker(botName: string): string {
  const safe = botName.replace(/[<>]/g, ' ').replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim()
  return `${MARKER_PREFIX}${safe || 'bot'} -->`
}

/** The bot a body says it was written by, or null when it carries no marker. */
export function botGhMarkerOf(text: string | undefined): string | null {
  const found = text ? MARKER_PATTERN.exec(text) : null
  const name = found?.[1]?.trim()
  return name ? name : null
}

/** A string as a POSIX shell single-quoted word. */
function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The shim itself, in bash. On a verb that posts a body (`pr`/`issue` `comment`, `create`, `edit`, and
 * `pr review`, `new` being gh's own alias for `create`) a body flag is replaced by one `--body` carrying
 * the marker, and every other call runs untouched. Shapes it cannot mark — `--fill*`, a template with no
 * body, a combined short flag hiding `-b`/`-F` — are refused with exit 2 instead of posting unmarked.
 * The body travels as an argument (GitHub caps one at 65,536 characters), so no temp file can leak.
 */
export function botGhShimScript(marker: string): string {
  return [
    '#!/usr/bin/env bash',
    "# Orca: a bot's own gh. It appends the bot's marker to any body this call posts, and passes",
    '# every other call through unchanged.',
    'set -u',
    '',
    `marker=${shellQuoted(marker)}`,
    '',
    '# The real gh: the first one on PATH that is not this shim itself.',
    'real_gh=',
    'rest=$PATH',
    'while [ -n "$rest" ]; do',
    '  dir=${rest%%:*}',
    '  case $rest in',
    '    *:*) rest=${rest#*:} ;;',
    '    *) rest= ;;',
    '  esac',
    '  [ -n "$dir" ] || dir=.',
    '  if [ -f "$dir/gh" ] && [ -x "$dir/gh" ] && [ ! "$dir/gh" -ef "$0" ]; then',
    '    real_gh=$dir/gh',
    '    break',
    '  fi',
    'done',
    'if [ -z "$real_gh" ]; then',
    "  printf 'gh: command not found\\n' >&2",
    '  exit 127',
    'fi',
    '',
    'args=("$@")',
    'count=${#args[@]}',
    '',
    "# The verb, skipping -R/--repo (persistent, so it may sit before the verb) and each flag's value.",
    'group=',
    'sub=',
    'i=0',
    'while [ "$i" -lt "$count" ]; do',
    '  arg=${args[$i]}',
    '  case $arg in',
    '    -R|--repo|-b|--body|-F|--body-file) i=$((i + 2)); continue ;;',
    '    --repo=*|--body=*|--body-file=*) i=$((i + 1)); continue ;;',
    '    -*) i=$((i + 1)); continue ;;',
    '  esac',
    '  if [ -z "$group" ]; then',
    '    group=$arg',
    '  elif [ -z "$sub" ]; then',
    '    sub=$arg',
    '  fi',
    '  i=$((i + 1))',
    'done',
    '',
    '# gh aliases new to create; the marker follows the verb gh actually runs.',
    'if [ "$sub" = new ]; then',
    '  sub=create',
    'fi',
    'case "$group $sub" in',
    '  "pr comment"|"issue comment"|"pr review"|"pr create"|"pr edit"|"issue create"|"issue edit") ;;',
    '  *) exec "$real_gh" "$@" ;;',
    'esac',
    '',
    '# Refused rather than posted unmarked: gh writes these bodies itself, so there is nothing to mark.',
    'refuse() {',
    '  printf \'orca gh shim: %s %s %s. Pass --body <text>.\\n\' "$group" "$sub" "$1" >&2',
    '  exit 2',
    '}',
    'template=0',
    'for arg in "$@"; do',
    '  case $arg in',
    '    --fill|--fill-first|--fill-verbose) refuse "writes a body from commits, which this shim cannot mark" ;;',
    '    -T|--template|--template=*) template=1 ;;',
    '  esac',
    'done',
    '',
    '# The last body flag wins, as it does for gh; every one of them is dropped from the call.',
    'drop=" "',
    'body_file=0',
    'body_value=',
    'saw_body=0',
    'saw_file=0',
    'i=0',
    'while [ "$i" -lt "$count" ]; do',
    '  arg=${args[$i]}',
    '  next=$((i + 1))',
    '  case $arg in',
    '    -b|--body)',
    '      body_file=0',
    '      saw_body=1',
    '      body_value=${args[$next]-}',
    '      drop="$drop$i $next "',
    '      i=$((i + 2))',
    '      continue',
    '      ;;',
    '    -F|--body-file)',
    '      body_file=1',
    '      saw_file=1',
    '      body_value=${args[$next]-}',
    '      drop="$drop$i $next "',
    '      i=$((i + 2))',
    '      continue',
    '      ;;',
    '    --body=*|-b=*|--body-file=*|-F=*)',
    '      case $arg in',
    '        --body=*|-b=*) body_file=0; saw_body=1; body_value=${arg#*=} ;;',
    '        *) body_file=1; saw_file=1; body_value=${arg#*=} ;;',
    '      esac',
    '      drop="$drop$i "',
    '      i=$((i + 1))',
    '      continue',
    '      ;;',
    '    -b?*|-F?*)',
    '      case $arg in',
    '        -b?*) body_file=0; saw_body=1; body_value=${arg#-b} ;;',
    '        *) body_file=1; saw_file=1; body_value=${arg#-F} ;;',
    '      esac',
    '      drop="$drop$i "',
    '      i=$((i + 1))',
    '      continue',
    '      ;;',
    '    -[A-Za-z][A-Za-z]*)',
    '      # A combined short flag can hide -b/-F, so a group holding one is refused, not guessed at.',
    '      case $arg in',
    '        -*b*|-*F*) refuse "hides --body or --body-file in a combined short flag" ;;',
    '      esac',
    '      ;;',
    '  esac',
    '  i=$((i + 1))',
    'done',
    '',
    'if [ "$template" = 1 ] && [ "$body_value" = "" ]; then',
    '  refuse "writes a body from a template, which this shim cannot mark"',
    'fi',
    '# gh refuses both together, so this does too, rather than posting whichever came last.',
    'if [ "$saw_body" = 1 ] && [ "$saw_file" = 1 ]; then',
    '  exec "$real_gh" "$@"',
    'fi',
    '',
    'if [ "$body_file" = 1 ]; then',
    '  if [ "$body_value" = - ]; then',
    '    body_value=$(cat)',
    '  elif [ -n "$body_value" ] && [ -r "$body_value" ]; then',
    '    body_value=$(cat -- "$body_value")',
    '  else',
    '    exec "$real_gh" "$@"',
    '  fi',
    'fi',
    '',
    '# An empty body stays empty: a marker on its own would turn a refused comment into a blank one.',
    'if [ -z "$body_value" ]; then',
    '  exec "$real_gh" "$@"',
    'fi',
    '',
    'kept=()',
    'i=0',
    'while [ "$i" -lt "$count" ]; do',
    '  case "$drop" in',
    '    *" $i "*) i=$((i + 1)); continue ;;',
    '  esac',
    '  kept+=("${args[$i]}")',
    '  i=$((i + 1))',
    'done',
    'exec "$real_gh" "${kept[@]}" --body "$body_value"$\'\\n\\n\'"$marker"',
    ''
  ].join('\n')
}

/** Where one bot's shim lives: beside its home, not in it, so the bot's own files stay its own. */
export function botGhShimDir(botId: string): string {
  return join(botsRootFolder(), '.gh-shims', botId)
}

/** Writes the bot's shim, or leaves the one already there; null when this platform has no shim. */
export async function installBotGhShim(bot: { id: string; name: string }): Promise<string | null> {
  // A POSIX shell script is what a bot's `gh` calls run; Windows bots keep no marker yet.
  if (process.platform === 'win32') {
    return null
  }
  const dir = botGhShimDir(bot.id)
  const file = join(dir, 'gh')
  const script = botGhShimScript(botGhMarker(bot.name))
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (existing !== script) {
    await mkdir(dir, { recursive: true })
    // A live session runs this file: write beside it and rename, so it never sees half a script.
    const staged = `${file}.${randomUUID()}.tmp`
    await writeFile(staged, script, { mode: 0o755 })
    await rename(staged, file)
  }
  return dir
}

/** The bot's launch env carrying its shim folder, or an empty env when there is none to install. A
 *  launch that cannot name its bot installs none, rather than marking with something else. */
export async function botGhShimEnv(bot: {
  id: string
  name?: string
}): Promise<Record<string, string>> {
  if (!bot.name) {
    return {}
  }
  try {
    const dir = await installBotGhShim({ id: bot.id, name: bot.name })
    return dir ? { [BOT_GH_SHIM_DIR_ENV]: dir } : {}
  } catch (error) {
    console.warn('[bots] could not install the gh marker shim', error)
    return {}
  }
}

/** `env` with the bot's shim folder first on PATH, and its key taken back out; unchanged without one. */
export function withBotGhShimOnPath(env: Readonly<Record<string, string>>): Record<string, string> {
  const { [BOT_GH_SHIM_DIR_ENV]: dir, ...rest } = env
  if (!dir) {
    return { ...rest }
  }
  const path = rest.PATH ?? rest.Path
  const key = rest.PATH === undefined && rest.Path !== undefined ? 'Path' : 'PATH'
  return { ...rest, [key]: path ? `${dir}${delimiter}${path}` : dir }
}
