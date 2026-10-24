import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { resolveSpawn, type ResolvedSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import type { ProcessSpec, ProcessResult } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'

/**
 * Synchronous variant, for the call sites that genuinely cannot await — CLI
 * entry points and teardown paths that run while the event loop is stopping.
 *
 * Prefer `runProcess`. This exists so those callers still get the Windows
 * invariants (hidden console, correct `.cmd` argv) instead of reaching for
 * `execFileSync` and re-deciding them.
 */
export function runProcessSync(spec: ProcessSpec): ProcessResult {
  const resolved = resolveSpawn(spec, process.platform)
  // Diagnostics only: spawnSync holds the calling thread until the child exits,
  // so the whole call is the block, reported even when it throws.
  const spawnStartedAt = hasSpawnObserver() ? performance.now() : null
  try {
    return runResolvedProcessSync(spec, resolved)
  } finally {
    if (spawnStartedAt !== null) {
      notifySpawnObserver(resolved.file, resolved.args, performance.now() - spawnStartedAt)
    }
  }
}

function runResolvedProcessSync(spec: ProcessSpec, resolved: ResolvedSpawn): ProcessResult {
  const result = nodeSpawnSync(resolved.file, [...resolved.args], {
    ...resolved.options,
    input: spec.input,
    timeout: spec.timeoutMs === null ? undefined : (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
    maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    // Keep raw output without applying the nonexistent 'buffer' encoding to string stdin.
    encoding: null
  })
  const timedOut = result.error
    ? 'code' in result.error && result.error.code === 'ETIMEDOUT'
    : false
  if (result.error && !timedOut) {
    throw result.error
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: spec.captureStdoutAsBytes ? '' : (result.stdout?.toString('utf8') ?? ''),
    ...(spec.captureStdoutAsBytes ? { stdoutBytes: result.stdout ?? Buffer.alloc(0) } : {}),
    stderr: result.stderr?.toString('utf8') ?? '',
    // Why always false: spawnSync reports an overrun as an ENOBUFS error, and
    // the guard above rethrows it, so no truncated result reaches this point.
    outputTruncated: false,
    // Why ETIMEDOUT and not the signal: a timeout kills with SIGTERM, but so
    // does anything else that terminates the child, and only a timeout also
    // sets this error. Reading the signal alone reports a deliberately
    // stopped process as having timed out, which callers retry.
    timedOut
  }
}
