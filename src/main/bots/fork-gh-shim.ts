// The marker every bot-written GitHub body carries, appended by a `gh` the bot cannot skip: a fork
// shim first on the bot's PATH. Omission is the risk that matters — a forgotten marker wakes the bot
// on its own output — so the marker is written by code, never remembered by the model.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { botsRootFolder } from './bot-home'

/** The env key a bot's launch carries its shim folder in; `withBotLaunchToolsEnv` puts it on PATH. */
export const BOT_GH_SHIM_DIR_ENV = 'ORCA_BOT_GH_SHIM_DIR'

const MARKER_PREFIX = '<!-- orca-bot:'
const MARKER_PATTERN = /<!--\s*orca-bot:([^>]*?)\s*-->/u

/** The marker a body written as `botName` carries, invisible to anyone reading it rendered. */
export function botGhMarker(botName: string): string {
  return `${MARKER_PREFIX}${botName.trim()} -->`
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
 * The shim itself, in bash: `gh pr comment`, `gh issue comment` and `gh pr review` get the marker on
 * their body (inline, or a marked copy of `--body-file`), and every other call runs untouched.
 */
export function botGhShimScript(marker: string): string {
  return [
    '#!/usr/bin/env bash',
    "# Orca: a bot's own gh. It appends the bot's marker to a comment or review body and passes",
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
    'verb=',
    'case ${1-} in',
    '  pr|issue)',
    '    case ${2-} in',
    '      comment|review) verb="$1 $2" ;;',
    '    esac',
    '    ;;',
    'esac',
    'case $verb in',
    '  "pr comment"|"issue comment"|"pr review") ;;',
    '  *) exec "$real_gh" "$@" ;;',
    'esac',
    '',
    'args=("$@")',
    'count=${#args[@]}',
    'body_at=-1',
    'file_at=-1',
    'i=0',
    'while [ "$i" -lt "$count" ]; do',
    '  case ${args[$i]} in',
    '    --body=*|--body|-b) [ "$body_at" -lt 0 ] && body_at=$i ;;',
    '    --body-file=*|--body-file|-F) [ "$file_at" -lt 0 ] && file_at=$i ;;',
    '  esac',
    '  i=$((i + 1))',
    'done',
    '',
    '# No body to mark (a review verdict, say): nothing to do.',
    'if [ "$body_at" -lt 0 ] && [ "$file_at" -lt 0 ]; then',
    '  exec "$real_gh" "$@"',
    'fi',
    '',
    'if [ "$body_at" -ge 0 ]; then',
    '  arg=${args[$body_at]}',
    '  case $arg in',
    '    --body=*) args[$body_at]="--body=${arg#--body=}"$\'\\n\\n\'"$marker" ;;',
    '    *)',
    '      next=$((body_at + 1))',
    '      [ "$next" -lt "$count" ] || exec "$real_gh" "$@"',
    '      args[$next]=${args[$next]}$\'\\n\\n\'"$marker"',
    '      ;;',
    '  esac',
    '  exec "$real_gh" "${args[@]}"',
    'fi',
    '',
    "# --body-file: gh reads a marked copy, and the bot's own file is left as it was.",
    'arg=${args[$file_at]}',
    'case $arg in',
    '  --body-file=*) path=${arg#--body-file=} ;;',
    '  *) path=${args[$((file_at + 1))]:-} ;;',
    'esac',
    'marked=$(mktemp "${TMPDIR:-/tmp}/orca-gh-body.XXXXXXXX") || exec "$real_gh" "$@"',
    'if [ "$path" = - ]; then',
    '  cat > "$marked" || { rm -f -- "$marked"; exec "$real_gh" "$@"; }',
    'elif [ -n "$path" ] && [ -r "$path" ]; then',
    '  cat -- "$path" > "$marked" || { rm -f -- "$marked"; exec "$real_gh" "$@"; }',
    'else',
    '  rm -f -- "$marked"',
    '  exec "$real_gh" "$@"',
    'fi',
    'printf \'\\n\\n%s\\n\' "$marker" >> "$marked"',
    'case $arg in',
    '  --body-file=*) args[$file_at]="--body-file=$marked" ;;',
    '  *) args[$((file_at + 1))]=$marked ;;',
    'esac',
    '"$real_gh" "${args[@]}"',
    'status=$?',
    'rm -f -- "$marked"',
    'exit $status',
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
    await writeFile(file, script, { mode: 0o755 })
  }
  return dir
}

/** The bot's launch env carrying its shim folder, or an empty env when there is none to install. */
export async function botGhShimEnv(bot: {
  id: string
  name: string
}): Promise<Record<string, string>> {
  try {
    const dir = await installBotGhShim(bot)
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
