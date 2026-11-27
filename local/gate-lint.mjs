#!/usr/bin/env node
/**
 * Lint-gate verdict for this fork.
 *
 * `pnpm lint` is one `&&` chain, so it stops at the first failing step and says nothing about the
 * rest. That is how four ratchet reds (#161) hid each other, and why a red this fork did not cause
 * has had to be hand-verified as pre-existing in an unrelated PR. This gate runs every step — the
 * chain's and `FORK_LINT_STEPS` — on its own and turns the set of failures into a verdict: a failure listed in
 * `local/lint-known-red.json` is reported but does not fail the gate, a failure outside it does.
 *
 * Same shape as `local/gate-unit.mjs` for the unit suite (AGENTS.md § Release gate), and the same
 * rule: `LOCAL-PATCHES.md` stays the evidence, `local/lint-known-red.json` stays the assertion, and
 * both change in the commit that adds or removes an entry.
 *
 * Every step runs under a deadline that reaches its whole process tree, and the step is named before
 * it can hang: `pnpm run` puts the real linter one level down, so a kill aimed at the direct child
 * left a grandchild holding the output pipe and the gate waited ~48 minutes for a stream that could
 * not close (#446). See `runStep`.
 *
 * Usage: node local/gate-lint.mjs [--allowlist PATH] [--only id,id | --fast] [--timeout-ms N]
 *                                 [--prune] [--verbose]
 *
 *   --only     run just these step ids, for iterating on one ratchet.
 *   --fast     run `FAST_LINT_STEPS`, the inner-loop subset: under a minute, no queue, no marker.
 *   --prune    drop entries that no longer reproduce and the steps that no longer exist.
 *   --timeout-ms N   per-step deadline, default 10 minutes; an overrun fails the gate.
 *
 * A full, clean PASS also records a verdict marker under the git common dir (see
 * `local/gate-lint-verdict.mjs`), so "did lint pass for revision X" is answerable without re-running
 * all 54 steps. A FAIL is not a verdict and a `--only` or dirty run names no commit, so neither
 * records one.
 *
 * Exit: 0 pass, 1 new red or a step that timed out, 2 usage or environment problem.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { lintVerdictTarget, writeLintVerdict } from './gate-lint-verdict.mjs'
import { entryProblem, matchesEntry } from './lib/known-red.mjs'

export { entryProblem, matchesEntry }

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_ALLOWLIST = join(ROOT, 'local', 'lint-known-red.json')
// Why 10 and not 30: a lint step that has not answered in ten minutes is hung, not slow, and the job
// around this gate has 50 minutes for ~55 steps (#446).
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
// Why a deadline past the kill: SIGKILL on the group is enough unless a grandchild left it, in which
// case the pipe stays open and `close` never fires — the hang this gate exists to fix.
const KILL_GRACE_MS = 5 * 1000
// Why after `exit` and not at the deadline: a step that finished must not hold the gate for its whole
// deadline because a child it left kept the pipe open (`KILL_GRACE_MS` is that same window, post-kill).
const DRAIN_GRACE_MS = 5 * 1000
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const TAIL_LINES = 8
/** `setTimeout` overflows above this, firing at 1 ms instead of the requested deadline. */
const MAX_TIMEOUT_MS = 2147483647

/**
 * A line the CI log has to have *before* the next step starts.
 *
 * Why awaited: the gate used to print a step only after it finished, so a step that never finished left
 * no name behind (#446). Awaiting puts the line in the pipe before the step can hang, so a runner that
 * kills the step still has it in the log.
 */
function writer(stream) {
  return (line) => new Promise((done) => stream.write(`${line}\n`, () => done()))
}

const writeOut = writer(process.stdout)
const writeErr = writer(process.stderr)

/** The last lines a hung step managed to print, which is all the `::error::` line can quote. */
export function tailLines(output, limit = TAIL_LINES) {
  const lines = output.split('\n').map((line) => line.trimEnd())
  return lines.filter((line) => line.trim().length > 0).slice(-limit)
}

function usage() {
  return 'usage: node local/gate-lint.mjs [--allowlist PATH] [--only id,id | --fast] [--timeout-ms N] [--prune] [--verbose]'
}

function parseArgs(argv) {
  const options = {
    allowlist: DEFAULT_ALLOWLIST,
    only: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prune: false,
    verbose: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--allowlist') {
      options.allowlist = resolve(argv[(index += 1)] ?? '')
    } else if (arg === '--only') {
      options.only = (argv[(index += 1)] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[(index += 1)])
    } else if (arg === '--fast') {
      options.only = [...FAST_LINT_STEPS]
    } else if (arg === '--prune' || arg === '--verbose') {
      options[arg.slice(2)] = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n${usage()}`)
      process.exit(2)
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    console.error('--timeout-ms must be a positive integer')
    process.exit(2)
  }
  if (options.timeoutMs > MAX_TIMEOUT_MS) {
    console.error(`--timeout-ms must not exceed ${MAX_TIMEOUT_MS}`)
    process.exit(2)
  }
  return options
}

/**
 * The steps of `package.json`'s `lint` chain, in order.
 *
 * `argv` is what actually runs: a nested `pnpm run X` stays a nested script so it gets the same
 * environment and PATH (oxlint lives in `node_modules/.bin`), and a bare command is run through
 * `pnpm exec` for the same reason. The id is the script name where there is one, because that is
 * what a reader of `pnpm lint` recognises.
 */
export function resolveLintSteps(scripts) {
  const chain = (scripts.lint ?? '')
    .split('&&')
    .map((step) => step.trim())
    .filter(Boolean)
  if (chain.length === 0) {
    throw new Error('package.json has no lint script')
  }
  return chain.map((command) => {
    const nested = /^pnpm run ([\w:-]+)$/.exec(command)
    if (nested) {
      if (!scripts[nested[1]]) {
        throw new Error(`lint step runs "${nested[1]}", which is not a package.json script`)
      }
      return { id: nested[1], command, argv: ['pnpm', 'run', nested[1]] }
    }
    const direct = /^node (config\/scripts\/[\w./-]+\.mjs)(.*)$/.exec(command)
    if (direct) {
      // Why the trailing arguments: a `generate-*.mjs --check` step run without its flag writes
      // instead of checking, which would dirty the tree and still exit 0.
      const rest = direct[2].trim()
      return {
        id: basename(direct[1], '.mjs'),
        command,
        argv: ['node', direct[1], ...(rest ? rest.split(/\s+/) : [])]
      }
    }
    return { id: command, command, argv: ['pnpm', 'exec', ...command.split(/\s+/)] }
  })
}

/**
 * Upstream replaced package.json's inline lint chain with one `run-lint.mjs` step that runs `LINT_STEPS`
 * itself. Resolved literally that is one gate step, which loses per-step attribution and `--only`, so
 * the gate expands it back into the steps it runs. Fails closed: a reworded runner must not silently
 * collapse the gate.
 */
function expandConsolidatedRunner(steps, root) {
  return steps.flatMap((step) => {
    const script = /^node (config\/scripts\/[\w./-]+\.mjs)$/.exec(step.command)
    if (!script || basename(script[1]) !== 'run-lint.mjs') {
      return [step]
    }
    const declared = /export const LINT_STEPS = \[([\s\S]*?)\n\]/.exec(
      readFileSync(join(root, script[1]), 'utf8')
    )
    if (!declared) {
      throw new Error(
        `${script[1]} declares no LINT_STEPS, so the lint gate cannot attribute steps`
      )
    }
    const names = [...declared[1].matchAll(/'([\w:.-]+)'/g)].map((match) => match[1])
    if (names.length === 0) {
      throw new Error(`${script[1]}: LINT_STEPS parsed empty`)
    }
    // `oxlint` has no package script of its own — upstream resolves the binary directly.
    return names.map((name) => ({
      id: name,
      command: name === 'oxlint' ? 'oxlint' : `pnpm run ${name}`,
      argv: name === 'oxlint' ? ['pnpm', 'exec', 'oxlint'] : ['pnpm', 'run', name]
    }))
  })
}

/**
 * Fork-only lint steps, run beside the chain. Why not in `package.json`'s `lint`: that is one line
 * upstream edits ~100 times a month, so a step prepended to it conflicts on every sync. This file is
 * fork-owned, so a sync cannot drop a step from here.
 */
export const FORK_LINT_STEPS = [
  {
    id: 'check-upstream-identity-literals',
    command: 'node config/scripts/check-upstream-identity-literals.mjs',
    argv: ['node', 'config/scripts/check-upstream-identity-literals.mjs']
  },
  {
    id: 'check-upstream-file-comments',
    command: 'node local/check-upstream-file-comments.mjs',
    argv: ['node', 'local/check-upstream-file-comments.mjs']
  },
  {
    // The host group's own seam register: how many lines it costs in upstream-owned files, and which ones.
    // Beside the comment ratchet above because the two answer the same question from opposite sides.
    // It decides strictness from the diff itself (a branch touching this feature's own files must declare every
    // upstream file it touches) because no flag here would ever be passed — #471's workspace fix touches eight
    // upstream files and no feature file, and it is the diff case that has to stay green.
    id: 'check-host-mesh-upstream-seams',
    command: 'node local/checks/host-mesh-upstream-seams.mjs --base origin/main',
    argv: ['node', 'local/checks/host-mesh-upstream-seams.mjs', '--base', 'origin/main']
  },
  // Why these three are fork-only additions rather than chain steps: upstream's run-lint.mjs replaced
  // package.json's inline `lint` chain in the 2026-10-28 sync and does not know them, so taking that
  // refactor silently stopped running them.
  {
    id: 'check:process-host-imports',
    command: 'pnpm run check:process-host-imports',
    argv: ['pnpm', 'run', 'check:process-host-imports']
  },
  {
    id: 'check:workspace-path-sync-fs-ratchet',
    command: 'pnpm run check:workspace-path-sync-fs-ratchet',
    argv: ['pnpm', 'run', 'check:workspace-path-sync-fs-ratchet']
  },
  {
    id: 'check:compat-boundary-imports',
    command: 'pnpm run check:compat-boundary-imports',
    argv: ['pnpm', 'run', 'check:compat-boundary-imports']
  }
]

/**
 * The inner-loop subset `--fast` runs: every step that reddened a PR, measured 2026-11-13 → 11-27, that
 * finishes in seconds. 37 of 118 `Fork PR gates` runs failed the lint verdict, and every one of those 37
 * failed at least one step listed here; 31 failed only steps listed here. Run together they took 45 s on
 * this machine, against ~10 minutes and the queue for the full gate.
 *
 * Why not inside `check:code-quality:changed`: that script is upstream's and at its line budget, and most
 * of these are fork steps or whole-repo ratchets that a changed-lines scan cannot express.
 *
 * It is a subset, so a `--fast` PASS records no marker and satisfies no gate: `open-pr.mjs` still needs a
 * full run. Ids are checked against the resolved steps like `--only`, so a sync that renames one fails
 * loudly instead of running less.
 */
export const FAST_LINT_STEPS = [
  'check-upstream-file-comments',
  'check-upstream-identity-literals',
  'check-host-mesh-upstream-seams',
  'check:workspace-path-sync-fs-ratchet',
  'check:main-blocking-helper-ratchet',
  'check:main-sync-fs-ratchet',
  'check:runtime-electron-ratchet',
  'check:recurring-timer-ratchet',
  'check:max-lines-ratchet',
  'check:focus-read-ratchet',
  'verify:bundled-skill-guides',
  'verify:skill-bundle-manifest',
  'verify:localization-extraction',
  'verify:localization-catalogs',
  'verify:localization-coverage',
  'check:readme-local-links'
]

/**
 * The chain plus the fork steps. A fork step whose script is gone throws rather than being skipped,
 * and one a sync has put back into the chain runs once.
 *
 * A `pnpm`-shaped fork step is validated against the manifest at `root`, not against `scripts`: a
 * caller may pass a synthetic `scripts` to read the chain, while the fork's own steps are facts
 * about this repository.
 */
export function resolveGateSteps(scripts, forkSteps = FORK_LINT_STEPS, root = ROOT) {
  const chain = expandConsolidatedRunner(resolveLintSteps(scripts), root)
  let manifest = null
  for (const step of forkSteps) {
    if (step.argv[0] === 'pnpm') {
      manifest ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}
      if (!manifest[step.id]) {
        throw new Error(`fork lint step "${step.id}" has no package.json script`)
      }
      continue
    }
    if (!existsSync(join(root, step.argv[1]))) {
      throw new Error(`fork lint step "${step.id}" runs ${step.argv[1]}, which does not exist`)
    }
  }
  return [...chain, ...forkSteps.filter((step) => !chain.some((own) => own.id === step.id))]
}

/**
 * One signature per failure inside a step's output, for the step shapes that fail per item.
 *
 * A run that fails without any of these shapes still counts as one failure — see `classifyRun`,
 * which falls back to the last non-empty line — so nothing is ever allowed by being unparseable.
 */
export function extractFailureLines(output) {
  const lines = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    // `::error::text` and `::error file=x,line=1::text` are both failure lines, and the parameters
    // are part of the signature: a ratchet prints the same text for every offending file, so the
    // text alone would collapse two files into one line a single entry then allows.
    const gh = /^::error(?:\s+([^:]*))?::(.+)$/.exec(line)
    if (gh) {
      const file = /(?:^|,)\s*file=([^,]*)/.exec(gh[1] ?? '')?.[1]?.trim()
      lines.push(file ? `${file}: ${gh[2].trim()}` : gh[2].trim())
      continue
    }
    // `check-*-ratchet` count rows: grown then shrunk.
    if (
      /^.+: \d+ [^,]+\(s\), baseline allows \d+\.$/.test(line) ||
      /^.+: now \d+, baseline \d+\.$/.test(line)
    ) {
      lines.push(line)
    }
  }
  return [...new Set(lines)]
}

/**
 * Failure evidence the line parser above cannot attribute, so a step cannot pass on a partial parse.
 *
 * Why this exists: `extractFailureLines` judges only the lines whose shape it recognises, so a step
 * that exits non-zero printing two allowlisted rows plus an ast-grep diagnostic or a crash block
 * passed — the unrecognised text was never read. `lint:ast-grep-gates` is exactly that shape: one
 * step running two gates, where the flaky-test ratchet prints rows and the lint half prints
 * diagnostics.
 */
const UNACCOUNTED_EVIDENCE = [
  // ast-grep / rustc-style diagnostics, which is what the lint half of that step prints.
  /^(?:error|warning|note)\[[\w.:-]+\]\s*:/,
  // A crash block: a `Name [CODE]: message` header whose name ends in Error/Exception (`Error
  // [ERR_MODULE_NOT_FOUND]`, `AssertionError [ERR_ASSERTION]`), or a bare fatal one.
  /^[A-Za-z]*(?:Error|Exception)\s*(?:\[[^\]]+\])?\s*:/i,
  /^(?:panic|fatal|error)\b\s*:/i
]

/** Lines of a failing step's output that carry failure evidence nothing has accounted for. */
export function unaccountedFailureLines(output, accounted = []) {
  const known = new Set(accounted)
  const lines = []
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || known.has(line)) {
      continue
    }
    if (UNACCOUNTED_EVIDENCE.some((pattern) => pattern.test(line))) {
      lines.push(line)
    }
  }
  return [...new Set(lines)]
}

/**
 * Turn step results into a verdict.
 *
 * `results`: `[{ id, exitCode, output, seconds }]`. `entries`: the allowlist's `entries`.
 * `chainSteps`: every step the chain defines, which is what an entry for a *missing* step is judged
 * against — `--only` runs a subset, and a subset must not read as "that step is gone".
 *
 * A step with no failure line extracted but a non-zero exit is one failure named after its last
 * output line. Only a whole-step entry can cover that, never a `match`: the fallback line stands
 * for output the parser could not split, so allowing it by pattern would allow the whole step.
 */
export function classifyRun(results, entries, chainSteps = results.map((result) => result.id)) {
  const known = []
  const unexpected = []
  const matchedEntries = new Set()
  const unparsedSteps = new Set()
  for (const result of results) {
    if (result.exitCode === 0) {
      continue
    }
    if (result.timedOut) {
      unparsedSteps.add(result.id)
      unexpected.push({ step: result.id, line: 'timed out before it finished reporting' })
      continue
    }
    const stepEntries = entries.filter((entry) => entry.step === result.id)
    // A whole-step entry allows every failure in it and nothing outside it.
    const wholeStep = stepEntries.find((entry) => entry.wholeStep === true)
    if (wholeStep) {
      known.push({ step: result.id, line: '(whole step)', entry: wholeStep })
      matchedEntries.add(wholeStep)
      continue
    }
    const lines = extractFailureLines(result.output)
    if (lines.length === 0) {
      unparsedSteps.add(result.id)
      const tail = result.output
        .split('\n')
        .map((line) => line.trim())
        .findLast(Boolean)
      unexpected.push({ step: result.id, line: tail ?? `exited ${result.exitCode} with no output` })
      continue
    }
    for (const line of lines) {
      const entry = stepEntries.find((candidate) => matchesEntry(line, candidate))
      if (entry) {
        known.push({ step: result.id, line, entry })
        matchedEntries.add(entry)
      } else {
        unexpected.push({ step: result.id, line })
      }
    }
    // Why after the lines and not instead of them: every parsed line above is attributable, and what
    // this adds is the evidence beside them that no entry could ever have covered. A step failing
    // for a reason its own parse could not split still has to fail the gate.
    for (const line of unaccountedFailureLines(result.output, lines)) {
      unexpected.push({ step: result.id, line: `unattributed failure output: ${line}` })
    }
  }
  const seenSteps = new Set(results.map((result) => result.id))
  const chain = new Set(chainSteps)
  // Why skip an unparseable step: its entries could not be evaluated at all, and calling them stale
  // would delete an allowlist that the step's own output failed to speak to.
  const staleEntries = entries.filter(
    (entry) =>
      seenSteps.has(entry.step) && !matchedEntries.has(entry) && !unparsedSteps.has(entry.step)
  )
  const staleSteps = entries.filter((entry) => !chain.has(entry.step))
  // Why here rather than in `matchesEntry`: a throw inside the line loop names one entry and stops the
  // gate, while a problem reaches the summary and lets every step be reported.
  const entryProblems = entries.map(entryProblem).filter(Boolean)
  return { known, unexpected, staleEntries, staleSteps, entryProblems }
}

function readManifest(path) {
  if (!existsSync(path)) {
    console.error(`missing allowlist at ${path}`)
    process.exit(2)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`cannot read ${path}: ${error.message}`)
    process.exit(2)
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Kill a step's whole process tree, not just the direct child.
 *
 * Why the process group: `pnpm run` puts the real linter one level down, so a kill aimed at the direct
 * child leaves a grandchild holding the output pipe — the gate then waits on a stream that cannot
 * close, which is the 48-minute hang in #446. `detached: true` makes the child a group leader so the
 * negative pid reaches everything it spawned.
 */
function killTree(child, signal = 'SIGKILL') {
  if (!child.pid) {
    return
  }
  if (process.platform === 'win32') {
    // Why taskkill: Windows has no process groups, and `/T` is the only tree kill it offers.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Why the fallback: a child that exited before becoming its own group leader, or one spawned
    // without `detached`, has no group to signal.
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Run one step under a deadline that reaches its grandchildren.
 *
 * Resolves — never rejects — with `{ id, command, exitCode, signal, output, tail, timedOut, seconds }`,
 * so a step that hangs is a result the verdict can name rather than a wait with no output.
 */
export function runStep(step, timeoutMs, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint()
    // Why one list per stream plus one in arrival order: a chunk boundary can fall mid-line, so a
    // failure line spliced with the other stream's bytes is a line no parser here would read — and a
    // real red would then pass. `spawnSync` gave stdout then stderr and never split a line; the
    // arrival order is kept only for the tail quoted on a timeout.
    const stdoutChunks = []
    const stderrChunks = []
    const orderedChunks = []
    let buffered = 0
    let truncated = false
    let timedOut = false
    let spawnError = null
    let settled = false
    let timer = null
    let graceTimer = null
    let drainTimer = null
    let exited = null
    const [program, ...args] = step.argv
    const settleAs = (output) =>
      resolve({
        id: step.id,
        command: step.command,
        exitCode: 1,
        signal: null,
        output,
        tail: tailLines(output),
        timedOut: false,
        seconds: Number(process.hrtime.bigint() - startedAt) / 1e9
      })
    let child
    try {
      child = spawn(program, args, {
        cwd,
        // Why POSIX only: it is what makes the child a process-group leader, and Windows has no
        // equivalent — `taskkill /T` covers the tree there.
        detached: process.platform !== 'win32',
        // Why stdin ignored: a step that reads it would wait for a TTY that never speaks.
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      // Why here and not as a rejection: every caller reads a result, and a step that could not start
      // is a red with evidence, not an unhandled throw halfway through the chain.
      settleAs(error.message)
      return
    }

    const collect = (sink) => (chunk) => {
      const room = Math.max(0, MAX_OUTPUT_BYTES - buffered)
      truncated ||= chunk.length > room
      if (room > 0) {
        const kept = chunk.subarray(0, room)
        sink.push(kept)
        orderedChunks.push(kept)
        buffered += kept.length
      }
    }
    child.stdout.on('data', collect(stdoutChunks))
    child.stderr.on('data', collect(stderrChunks))

    // Why forwarded: `detached` takes the step out of the terminal's foreground group, so without this
    // a Ctrl-C would leave the step running after the gate had gone.
    const interrupts = [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129]
    ].map(([signal, code]) => ({
      signal,
      handler: () => {
        killTree(child)
        process.exit(code)
      }
    }))
    for (const { signal, handler } of interrupts) {
      process.once(signal, handler)
    }

    const stop = () => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      clearTimeout(drainTimer)
      for (const { signal, handler } of interrupts) {
        process.off(signal, handler)
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      // Why: the gate has already reported this step, so a child that outlived the kill must not keep
      // the process alive and turn a verdict into another wait.
      child.unref()
    }

    const settle = (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      stop()
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8')
      const stderrText = Buffer.concat(stderrChunks).toString('utf8')
      const banner = `${truncated ? `\n[gate: output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ''}${spawnError ? `\n${spawnError.message}` : ''}`
      resolve({
        id: step.id,
        command: step.command,
        // Why 1 rather than a signal's null status: the verdict reads non-zero as "it failed", and
        // `timedOut` is what says why.
        exitCode: timedOut ? 1 : (code ?? 1),
        signal: signal ?? null,
        output: `${stdoutText}${stderrText}${banner}`,
        tail: tailLines(`${Buffer.concat(orderedChunks).toString('utf8')}${banner}`),
        timedOut,
        seconds: Number(process.hrtime.bigint() - startedAt) / 1e9
      })
    }

    child.once('exit', (code, signal) => {
      exited = { code, signal }
      drainTimer = setTimeout(() => {
        killTree(child)
        settle(code, signal)
      }, DRAIN_GRACE_MS)
    })

    timer = setTimeout(() => {
      // Why the exit test: the drain timer normally settles this first, and a step that finished keeps
      // its own exit code rather than being reported as a hang it did not have.
      if (exited !== null) {
        killTree(child)
        settle(exited.code, exited.signal)
        return
      }
      timedOut = true
      killTree(child)
      graceTimer = setTimeout(() => settle(null, null), KILL_GRACE_MS)
    }, timeoutMs)

    child.once('close', (code, signal) => settle(code, signal))
    child.once('error', (error) => {
      spawnError = error
      // Why the pid test: on a live child this event is a failed kill, not a failed spawn, and the
      // `close` that settles it is still coming.
      if (!child.pid) {
        settle(null, null)
      }
    })
  })
}

/**
 * Run steps in order, naming each one before it can hang.
 *
 * Why the `running` line is awaited: the gate used to print a step only after it finished, so a step
 * that never finished left the CI log and the alert email with no step name at all (#446).
 */
export async function runSteps(
  steps,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    verbose = false,
    cwd = ROOT,
    out = writeOut,
    err = writeErr
  } = {}
) {
  const results = []
  for (const [index, step] of steps.entries()) {
    const position = `[${index + 1}/${steps.length}]`
    await out(`running ${position} ${step.id} — ${step.command}`)
    const result = await runStep(step, timeoutMs, { cwd })
    results.push(result)
    const status = result.exitCode === 0 ? 'ok  ' : 'FAIL'
    await out(`  ${position} ${status} ${result.id} — ${result.seconds.toFixed(1)}s`)
    if (result.timedOut) {
      await err(
        `::error::lint step ${result.id} timed out after ${(timeoutMs / 1000).toFixed(1)}s (--timeout-ms ${timeoutMs}) and its process tree was killed; last output:`
      )
      for (const line of result.tail.length > 0 ? result.tail : ['(no output)']) {
        await err(`  | ${line}`)
      }
    }
    if (verbose && result.exitCode !== 0) {
      await out(result.output.trimEnd())
    }
  }
  return results
}

/**
 * Turn results into the printed verdict and the exit code.
 *
 * Split out of `main` so a test can drive the whole verdict — including the exit code a hung step
 * produces — without parsing arguments or spawning the real lint chain.
 */
export async function finalize(
  results,
  entries,
  chainSteps,
  {
    revision = 'unknown',
    // Why separate from `revision`: the printed label is the short sha a reader recognises, and the
    // marker has to be keyed by the full one so it can be compared with `rev-parse HEAD`.
    fullRevision = null,
    dirty = false,
    only = null,
    prune = false,
    allowlist = DEFAULT_ALLOWLIST,
    manifest = {},
    // Why injected: `finalize` is unit-tested with no repository behind it, so the real writer is
    // wired in `main` and a test passes a spy or nothing at all.
    recordVerdict = null,
    out = writeOut,
    err = writeErr
  } = {}
) {
  const { known, unexpected, staleEntries, staleSteps, entryProblems } = classifyRun(
    results,
    entries,
    chainSteps
  )
  const revisionLabel = `lint gate @${revision}${dirty ? '+dirty' : ''}`

  if (prune) {
    // Why only the entries this run could answer for: a --only run says nothing about the steps it
    // did not run, and pruning those would quietly un-allow a red nobody looked at.
    const kept = entries.filter(
      (entry) => !staleEntries.includes(entry) && !staleSteps.includes(entry)
    )
    writeFileSync(allowlist, `${JSON.stringify({ ...manifest, entries: kept }, null, 2)}\n`)
    await out(`pruned ${entries.length - kept.length} stale known-red entr(y/ies)`)
  }

  const totalSeconds = results.reduce((sum, result) => sum + result.seconds, 0)
  const failed = results.filter((result) => result.exitCode !== 0).length
  const summary =
    `${results.length - failed} green, ${failed} failing: ${known.length} known red, ` +
    `${unexpected.length} new; ${results.length} steps; ${totalSeconds.toFixed(1)} s`

  for (const { step, line, entry } of known) {
    await out(
      `known red ${step}: ${line} [${entry.class ?? 'unclassified'} / ${entry.owner ?? 'unattributed'}]`
    )
  }
  for (const { step, line } of unexpected) {
    await err(`::error::new lint red ${step}: ${line}`)
  }
  for (const result of results.filter((row) => row.timedOut)) {
    // Why its own line: a timeout is the one failure mode whose evidence is a missing report, so the
    // verdict has to say out loud that it is not, and can never be, a known red (#446).
    await err(
      `lint step ${result.id} timed out — a timeout is never a known red. Re-run it alone: node local/gate-lint.mjs --only ${result.id}`
    )
  }
  for (const problem of entryProblems) {
    await err(`::error::unusable known-red entry: ${problem}`)
  }
  // Why not ::error:: here: a stale entry is not a failure, and the runner reads that prefix as one.
  for (const entry of staleEntries) {
    await out(
      `stale known-red entry (prune it): ${entry.step}${entry.match ? ` /${entry.match}/` : ''}`
    )
  }
  for (const entry of staleSteps) {
    await err(`known-red entry for a step that no longer exists: ${entry.step}`)
  }
  if (unexpected.length > 0 || staleSteps.length > 0 || entryProblems.length > 0) {
    await err(`${revisionLabel}: FAIL — ${summary}`)
    if (unexpected.length > 0) {
      await err(
        'A new red is a real failure to fix, or a foreign one: record it in local/lint-known-red.json with its evidence and a LOCAL-PATCHES.md line, in the same commit.'
      )
    }
    // Why the ids and not just the count: #1539 printed only a tail, so #1541 re-ran all 54 steps on
    // the same revision with the same red. A known red is not a failure to fix, so it is named but
    // never re-run; a timed-out step is never a known red, so it always lands in the re-run list.
    const knownRedSteps = [...new Set(known.map((row) => row.step))]
    const rerunSteps = [...new Set(unexpected.map((row) => row.step))]
    if (knownRedSteps.length > 0) {
      await err(`known reds (recorded, not a fix): ${knownRedSteps.join(', ')}`)
    }
    if (rerunSteps.length > 0) {
      await err(`re-run what failed: node local/gate-lint.mjs --only ${rerunSteps.join(',')}`)
    }
    return 1
  }
  const staleNote = staleEntries.length > 0 ? ' (stale entries: run --prune)' : ''
  await out(`${revisionLabel}: PASS${staleNote} — ${summary}`)
  // Why only the full sha: a marker keyed by a short sha or by `unknown` would answer for nothing.
  await recordVerdict?.({ revision: fullRevision, dirty, only, steps: results })
  return 0
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const manifest = readManifest(options.allowlist)
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  const steps = resolveGateSteps(scripts)
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  const unknownOnly = (options.only ?? []).filter((id) => !steps.some((step) => step.id === id))
  if (unknownOnly.length > 0) {
    console.error(`no such lint step: ${unknownOnly.join(', ')}`)
    return 2
  }
  const selected = options.only ? steps.filter((step) => options.only.includes(step.id)) : steps

  const { revision, fullRevision, dirty, gitCommonDir } = lintVerdictTarget(git)
  await writeOut(
    `lint gate @${revision}${dirty ? '+dirty' : ''}: running ${selected.length}/${steps.length} steps`
  )

  const results = await runSteps(selected, {
    timeoutMs: options.timeoutMs,
    verbose: options.verbose
  })
  return finalize(
    results,
    entries,
    steps.map((step) => step.id),
    {
      revision,
      fullRevision,
      dirty,
      only: options.only,
      prune: options.prune,
      allowlist: options.allowlist,
      manifest,
      recordVerdict: (verdict) => gitCommonDir && writeLintVerdict({ ...verdict, gitCommonDir }),
      out: writeOut,
      err: writeErr
    }
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error)
      process.exitCode = 2
    }
  )
}
