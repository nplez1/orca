/** Characters cmd.exe expands or cannot escape inside quotes (%, !, "), and control characters. */
export function isCmdUnsafe(char: string): boolean {
  return char === '"' || char === '%' || char === '!' || char < ' ' || char === '\u007f'
}

/** cmd.exe resolves an extensionless name through PATHEXT to a file Orca never hashed. */
const CMD_RUNNABLE_EXTENSIONS = ['.cmd', '.bat', '.exe', '.com'] as const

function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export type AutomationScriptStepCommand =
  | { ok: true; command: string }
  | { ok: false; error: string }

/**
 * The command line the hook executor's shell runs for the verified copy at `executable` (an
 * absolute path). cmd.exe gets the exact file, never a name it could resolve through PATHEXT.
 */
export function automationScriptStepCommand(
  executable: string,
  args: readonly string[] | undefined,
  shell: 'posix' | 'cmd',
  /** WSL: the guest sets the copy's mode from the original, which a Windows host cannot set. */
  options: { modeFrom?: string } = {}
): AutomationScriptStepCommand {
  const argv = args ?? []
  if (shell === 'posix') {
    const run = [executable, ...argv].map(quotePosixArg).join(' ')
    if (!options.modeFrom) {
      return { ok: true, command: run }
    }
    const from = quotePosixArg(options.modeFrom)
    const copy = quotePosixArg(executable)
    // busybox chmod has no --reference; owner exec keeps a non-GNU guest running.
    return {
      ok: true,
      command: `{ chmod --reference=${from} ${copy} 2>/dev/null || chmod u+x ${copy}; } && ${run}`
    }
  }
  const lower = executable.toLowerCase()
  if (!CMD_RUNNABLE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return {
      ok: false,
      error: `on Windows a script step must name a ${CMD_RUNNABLE_EXTENSIONS.join(', ')} file.`
    }
  }
  if ([...executable].some(isCmdUnsafe)) {
    return { ok: false, error: 'the script path has characters cmd.exe would expand.' }
  }
  return { ok: true, command: [executable, ...argv].map((part) => `"${part}"`).join(' ') }
}
