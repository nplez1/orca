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
 * Usage: node local/gate-lint.mjs [--allowlist PATH] [--only id,id] [--timeout-ms N] [--prune]
 *                                 [--verbose]
 *
 *   --only     run just these step ids, for iterating on one ratchet.
 *   --prune    drop entries that no longer reproduce and the steps that no longer exist.
 *
 * Exit: 0 pass, 1 new red, 2 usage or environment problem.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_ALLOWLIST = join(ROOT, 'local', 'lint-known-red.json')
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

function usage() {
  return 'usage: node local/gate-lint.mjs [--allowlist PATH] [--only id,id] [--timeout-ms N] [--prune] [--verbose]'
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
    } else if (arg === '--prune') {
      options.prune = true
    } else if (arg === '--verbose') {
      options.verbose = true
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
  const chain = scripts.lint
    ?.split('&&')
    .map((step) => step.trim())
    .filter(Boolean)
  if (!chain) {
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
    const direct = /^node (config\/scripts\/[\w.-]+\.mjs)(.*)$/.exec(command)
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
    const script = /^node (config\/scripts\/[\w.-]+\.mjs)$/.exec(step.command)
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

/** Whether a failure line is covered by a known-red entry. An entry without `match` covers all. */
export function matchesEntry(line, entry) {
  if (!entry.match) {
    return true
  }
  try {
    return new RegExp(entry.match).test(line)
  } catch (error) {
    throw new Error(
      `known-red entry has an unusable match ${JSON.stringify(entry.match)}: ${error.message}`
    )
  }
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
    const wholeStep = stepEntries.find((entry) => !entry.match)
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
  return { known, unexpected, staleEntries, staleSteps }
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

function runStep(step, timeoutMs) {
  const startedAt = process.hrtime.bigint()
  const result = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs
  })
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9
  return {
    id: step.id,
    exitCode: result.error ? 1 : (result.status ?? 1),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
    // A killed step reported nothing complete, so its entries cannot be said to apply.
    timedOut: result.error?.code === 'ETIMEDOUT',
    seconds
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const manifest = readManifest(options.allowlist)
  const steps = resolveGateSteps(
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  )
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  const unknownOnly = (options.only ?? []).filter((id) => !steps.some((step) => step.id === id))
  if (unknownOnly.length > 0) {
    console.error(`no such lint step: ${unknownOnly.join(', ')}`)
    return 2
  }
  const selected = options.only ? steps.filter((step) => options.only.includes(step.id)) : steps

  const revision = git(['rev-parse', '--short', 'HEAD']) ?? 'unknown'
  const dirty = Boolean(git(['status', '--porcelain']))
  console.log(
    `lint gate @${revision}${dirty ? '+dirty' : ''}: running ${selected.length}/${steps.length} steps`
  )

  const results = []
  for (const [index, step] of selected.entries()) {
    const result = runStep(step, options.timeoutMs)
    results.push(result)
    const status = result.exitCode === 0 ? 'ok  ' : 'FAIL'
    console.log(
      `  [${index + 1}/${selected.length}] ${status} ${result.id} — ${result.seconds.toFixed(1)}s`
    )
    if (options.verbose && result.exitCode !== 0) {
      console.log(result.output.trimEnd())
    }
  }

  const { known, unexpected, staleEntries, staleSteps } = classifyRun(
    results,
    entries,
    steps.map((step) => step.id)
  )

  if (options.prune) {
    // Why only the entries this run could answer for: a --only run says nothing about the steps it
    // did not run, and pruning those would quietly un-allow a red nobody looked at.
    const kept = entries.filter(
      (entry) => !staleEntries.includes(entry) && !staleSteps.includes(entry)
    )
    writeFileSync(options.allowlist, `${JSON.stringify({ ...manifest, entries: kept }, null, 2)}\n`)
    console.log(`pruned ${entries.length - kept.length} stale known-red entr(y/ies)`)
  }

  const totalSeconds = results.reduce((sum, result) => sum + result.seconds, 0)
  const failed = results.filter((result) => result.exitCode !== 0).length
  const summary =
    `${results.length - failed} green, ${failed} failing: ${known.length} known red, ` +
    `${unexpected.length} new; ${results.length} steps; ${totalSeconds.toFixed(1)} s`

  for (const { step, line, entry } of known) {
    console.log(
      `known red ${step}: ${line} [${entry.class ?? 'unclassified'} / ${entry.owner ?? 'unattributed'}]`
    )
  }
  for (const { step, line } of unexpected) {
    console.error(`::error::new lint red ${step}: ${line}`)
  }
  // Why not ::error:: here: a stale entry is not a failure, and the runner reads that prefix as one.
  for (const entry of staleEntries) {
    console.log(
      `stale known-red entry (prune it): ${entry.step}${entry.match ? ` /${entry.match}/` : ''}`
    )
  }
  for (const entry of staleSteps) {
    console.error(`known-red entry for a step that no longer exists: ${entry.step}`)
  }
  if (unexpected.length > 0 || staleSteps.length > 0) {
    console.error(`lint gate @${revision}${dirty ? '+dirty' : ''}: FAIL — ${summary}`)
    if (unexpected.length > 0) {
      console.error(
        'A new red is a real failure to fix, or a foreign one: record it in local/lint-known-red.json with its evidence and a LOCAL-PATCHES.md line, in the same commit.'
      )
    }
    return 1
  }
  if (staleEntries.length > 0) {
    console.log(
      `lint gate @${revision}${dirty ? '+dirty' : ''}: PASS (stale entries: run --prune) — ${summary}`
    )
    return 0
  }
  console.log(`lint gate @${revision}${dirty ? '+dirty' : ''}: PASS — ${summary}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exit(main())
}
