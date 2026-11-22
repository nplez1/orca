// The patch, cut into review slices by subsystem under a byte budget.
//
// Why not equal line ranges, which the 2026-11-15 review used: a range cut lands mid-file and
// mid-hunk, so a reviewer starts on half a hunk and the next one ends on the other half, and a slice
// is "lines 28603-42903" rather than a part of the product. Here a slice is a run of whole path
// prefixes, a file is only split when it is bigger than the budget on its own, and then only at hunk
// boundaries.

/** One `diff --git` section of a patch, with what the inventory needs to describe it. */
export function parsePatch(text) {
  const sections = text.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '))
  return sections.map((section) => {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)
    if (!head) {
      // Why a message rather than a TypeError: a quoted or `noprefix` header is a git-config
      // surprise, and the reader needs to see which section it was.
      throw new Error(
        `cannot read the paths of a diff section: ${section.split('\n')[0].slice(0, 200)}`
      )
    }
    const header = section.split(/^@@ /m)[0]
    const deleted = /^deleted file mode/m.test(header)
    let added = 0
    let removed = 0
    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) {
        added += 1
      } else if (line.startsWith('-') && !line.startsWith('--- ')) {
        removed += 1
      }
    }
    return {
      path: deleted ? head[1] : head[2],
      status: /^new file mode/m.test(header)
        ? 'added'
        : deleted
          ? 'deleted'
          : /^rename from/m.test(header)
            ? 'renamed'
            : 'modified',
      conflict: /^remerge CONFLICT/m.test(header),
      bytes: Buffer.byteLength(section),
      added,
      removed,
      text: section
    }
  })
}

const sum = (entries) => entries.reduce((total, entry) => total + entry.bytes, 0)

/**
 * Path-prefix groups, each within the budget where a prefix allows it: a prefix over the budget is
 * split by its next path segment, and a file directly under it becomes its own group.
 */
export function groupBySubsystem(entries, budget, depth = 0, prefix = '') {
  const bytes = sum(entries)
  if (bytes <= budget || entries.length === 1) {
    return [{ prefix: entries.length === 1 ? entries[0].path : prefix, entries, bytes }]
  }
  const buckets = new Map()
  for (const entry of entries) {
    const segments = entry.path.split('/')
    const key =
      segments.length > depth + 1 ? `${segments.slice(0, depth + 1).join('/')}/` : entry.path
    buckets.set(key, [...(buckets.get(key) ?? []), entry])
  }
  if (buckets.size < 2) {
    // Why descend instead of stop: every entry sharing one *segment* is not the same as nothing left
    // to split by. `src/renderer/**` splits to a single `src/renderer/src/` bucket and stops there,
    // which leaves a 1 MB group that `pack` then exploded into one slice per file — 428 slices of
    // ~1.5 KB on the 2026-11-20 sync, ~$352 of review.
    const [only] = buckets.values()
    const identical = only.every((entry) => entry.path === only[0].path)
    // Why stop here and only here: a delete plus an add of the same path share a bucket at every
    // depth, so descending on identical paths never terminates.
    return identical
      ? [{ prefix, entries, bytes }]
      : groupBySubsystem(only, budget, depth + 1, prefix)
  }
  return [...buckets].flatMap(([key, bucket]) => groupBySubsystem(bucket, budget, depth + 1, key))
}

/** A file bigger than the budget, cut at hunk boundaries (and inside a hunk only when one is). */
export function splitEntry(entry, budget) {
  const [header, ...rawHunks] = entry.text.split(/^(?=@@ )/m)
  const room = Math.max(1, budget - Buffer.byteLength(header))
  const pieces = []
  for (const hunk of rawHunks) {
    if (Buffer.byteLength(hunk) <= room) {
      pieces.push(hunk)
      continue
    }
    let chunk = ''
    for (const line of hunk.split(/(?<=\n)/)) {
      if (chunk && Buffer.byteLength(chunk) + Buffer.byteLength(line) > room) {
        pieces.push(chunk)
        chunk = ''
      }
      chunk += line
    }
    if (chunk) {
      pieces.push(chunk)
    }
  }
  const parts = []
  for (const piece of pieces) {
    const last = parts.at(-1)
    if (last && Buffer.byteLength(last) + Buffer.byteLength(piece) <= room) {
      parts[parts.length - 1] = last + piece
    } else {
      parts.push(piece)
    }
  }
  return parts.map((body, index) => {
    const text = header + body
    return { ...entry, text, bytes: Buffer.byteLength(text), part: index + 1, parts: parts.length }
  })
}

/** `src/main/{a,b}`: consecutive prefixes under one parent, written once. */
export function describeScope(prefixes) {
  const runs = []
  for (const prefix of prefixes) {
    const trimmed = prefix.replace(/\/$/, '')
    const cut = trimmed.lastIndexOf('/')
    const parent = cut === -1 ? '' : trimmed.slice(0, cut)
    const leaf = trimmed.slice(cut + 1)
    const last = runs.at(-1)
    if (last && last.parent === parent) {
      last.leaves.push(leaf)
    } else {
      runs.push({ parent, leaves: [leaf] })
    }
  }
  return runs
    .map(({ parent, leaves }) => {
      // Why elide past four: the slice's full path list is in packet.json, and a scope line is
      // something a person reads in the manifest.
      const tail =
        leaves.length === 1
          ? leaves[0]
          : leaves.length <= 4
            ? `{${leaves.join(',')}}`
            : `{${leaves[0]} … ${leaves.at(-1)}} (${leaves.length})`
      return parent ? `${parent}/${tail}` : tail
    })
    .join(', ')
}

/** A, B, …, Z, AA, AB, … */
export function sliceId(index) {
  let id = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    id = String.fromCharCode(65 + ((n - 1) % 26)) + id
  }
  return id
}

/** Groups packed greedily, in path order, into slices of at most `cap` bytes. */
function pack(groups, budget, cap) {
  const slices = []
  let current = null
  const flush = () => {
    if (current) {
      slices.push(current)
      current = null
    }
  }
  for (const group of groups) {
    if (group.bytes > budget) {
      // Why packed rather than one slice each: an unsplittable group is still subject to the cap, and
      // a reviewer's fixed cost is paid per slice whatever its size, so 3 KB of patch must never cost
      // a whole reviewer boot of its own.
      for (const entry of group.entries) {
        for (const part of splitEntry(entry, budget)) {
          if (current && current.bytes + part.bytes > cap) {
            flush()
          }
          current ??= { prefixes: [], entries: [], bytes: 0 }
          if (!current.prefixes.includes(group.prefix)) {
            current.prefixes.push(group.prefix)
          }
          current.entries.push(part)
          current.bytes += part.bytes
        }
      }
      continue
    }
    if (current && current.bytes + group.bytes > cap) {
      flush()
    }
    current ??= { prefixes: [], entries: [], bytes: 0 }
    current.prefixes.push(group.prefix)
    current.entries.push(...group.entries)
    current.bytes += group.bytes
  }
  flush()
  return slices
}

/**
 * Adjacent groups packed into slices up to the budget, in path order, then evened out: the same
 * number of slices at the smallest cap that still yields it. Why: packing to the brim left a 47 KB
 * scrap of `tests/` after eleven full slices on the 2026-11-15 diff, and a reviewer's fixed cost
 * (reading the tree around a hunk) is paid per slice whatever its size.
 */
export function planSlices(entries, budget) {
  if (!entries.length) {
    // Why empty rather than one blank slice: a clean merge writes no hunks, and a blank slice would
    // reach a reviewer as a paid prompt about nothing.
    return []
  }
  const groups = groupBySubsystem(entries, budget)
  const count = pack(groups, budget, budget).length
  let low = Math.max(1, ...groups.filter((g) => g.bytes <= budget).map((g) => g.bytes))
  let high = budget
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (pack(groups, budget, middle).length <= count) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  const slices = pack(groups, budget, high)
  return slices.map((slice, index) => ({
    id: sliceId(index),
    scope:
      describeScope(slice.prefixes) +
      (slice.entries[0].parts > 1
        ? ` (part ${slice.entries[0].part} of ${slice.entries[0].parts})`
        : ''),
    files: new Set(slice.entries.map((entry) => entry.path)).size,
    bytes: slice.bytes,
    entries: slice.entries
  }))
}
