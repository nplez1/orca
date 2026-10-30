// Refuse a release body with no change summary, in the two places that decide whether one is ever
// published: the notes the macos job writes into the draft, and the body of the release the linux job
// is about to undraft.
//
// Why a guard and not the shell test it replaces: the runbook promises no release goes public without
// `## What changed` for the range, and the workflow published a minimal `Built from <sha>` body
// instead whenever the generator could not produce one — so the promise was kept by whoever
// remembered to read the draft. A stub is a silent install-instructions-only release, which is the
// exact failure the generator was introduced to remove.
//
// usage: fork-release-notes-guard.mjs <path|-> [--site generated|draft] [--label <what>]
// exit: 0 the body carries a change summary, 1 refuse, 2 usage
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The generator emits `## What changed` for a first release and `## What changed since <tag>` otherwise.
const SUMMARY_HEADING = /^## What changed/m
// Its own last-resort body when history is unusable. It carries the heading, so only its text says so.
const FALLBACK_MARKER = /^\*\*A change summary could not be generated/m
export const MIN_SUMMARY_BYTES = 400

/** `ok` with the reason, so the caller only has to decide how to fail. */
export function checkReleaseNotesBody(body) {
  const text = typeof body === 'string' ? body : ''
  if (!SUMMARY_HEADING.test(text)) {
    return {
      ok: false,
      reason: 'it has no "## What changed" section, so it says nothing about what changed'
    }
  }
  if (FALLBACK_MARKER.test(text)) {
    return {
      ok: false,
      reason:
        'it is the generator\'s fallback ("A change summary could not be generated"), which means git history for the range was unusable'
    }
  }
  const bytes = Buffer.byteLength(text)
  if (bytes < MIN_SUMMARY_BYTES) {
    return {
      ok: false,
      reason: `it is ${bytes} bytes, under the ${MIN_SUMMARY_BYTES} a real summary needs, so it is a fragment rather than the whole body`
    }
  }
  return { ok: true, reason: `${bytes} bytes with a change summary` }
}

/** What to do next depends on which of the two sites refused: only one of them is recoverable by re-running. */
const RECOVERY = {
  generated:
    'Nothing has gone public: this failed before a draft, a tag or an asset existed. Fix the cause ' +
    "(the generator's warning is in the same step's log — a shallow clone is the usual one) and " +
    'dispatch again.',
  draft:
    'Nothing has gone public: the release stays a draft, which no installed build can see. The body ' +
    "to fix is the draft's own — `gh release edit <tag> --notes-file notes.md`, or delete the draft " +
    'and start over. A re-dispatch will not rewrite it: an existing draft skips `gh release create`, ' +
    'so a re-run re-checks the same body and refuses again.'
}

function main(argv) {
  const args = [...argv]
  let label = 'the release body'
  const optionValue = (name) => {
    const index = args.indexOf(name)
    if (index === -1) {
      return null
    }
    const value = args.splice(index, 2)[1] ?? null
    return value
  }
  const labelOption = optionValue('--label')
  if (labelOption) {
    label = labelOption
  }
  const site = optionValue('--site') ?? 'generated'
  const [path, ...rest] = args
  if (!path || rest.length > 0 || !Object.hasOwn(RECOVERY, site)) {
    process.stderr.write(
      'usage: fork-release-notes-guard.mjs <path|-> [--site generated|draft] [--label <what>]\n'
    )
    return 2
  }
  let body
  try {
    body = readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch (error) {
    process.stderr.write(`::error::cannot read ${label} (${path}): ${error.message}\n`)
    return 1
  }
  const result = checkReleaseNotesBody(body)
  if (!result.ok) {
    process.stderr.write(
      `::error::refusing to publish: ${label} has no usable change summary — ${result.reason}. ` +
        `${RECOVERY[site]}\n`
    )
    return 1
  }
  process.stdout.write(`${label}: ${result.reason}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
