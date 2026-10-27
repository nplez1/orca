// Rendering for `conflicts.mjs`: the triage report as text. Kept out of the CLI so the CLI stays a
// shell over pure code, and so this file's own size is not a reason to stop adding report detail.
import { UNMERGED_STATUS } from './conflict-classify.mjs'

export const WIDTH = 100

export function truncate(text, width) {
  const characters = [...(text ?? '')]
  return characters.length <= width
    ? characters.join('')
    : `${characters.slice(0, Math.max(1, width - 1)).join('')}…`
}

export function classCounts(files) {
  const byClass = {}
  for (const file of files) {
    byClass[file.class] = (byClass[file.class] ?? 0) + 1
  }
  return {
    byClass,
    line: `${files.length} conflicted path(s): ${Object.entries(byClass)
      .sort((left, right) => right[1] - left[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(', ')}`
  }
}

function sideBySide(ours, theirs, limit = 8) {
  const column = Math.floor((WIDTH - 5) / 2)
  const rows = [`${'ours'.padEnd(column)} | theirs`]
  for (let index = 0; index < Math.min(Math.max(ours.length, theirs.length), limit); index += 1) {
    rows.push(
      `${truncate(ours[index] ?? '', column).padEnd(column)} | ${truncate(theirs[index] ?? '', column)}`
    )
  }
  const hidden = Math.max(ours.length, theirs.length) - limit
  if (hidden > 0) {
    rows.push(`… (+${hidden} more line(s) each)`)
  }
  return rows
}

function hunkRows(hunk) {
  const span = hunk.endLine ? `L${hunk.startLine}-${hunk.endLine}` : `L${hunk.startLine}`
  const sides = `ours +${hunk.delta.ours.added}/-${hunk.delta.ours.removed} (bal ${hunk.balance.ours})  theirs +${hunk.delta.theirs.added}/-${hunk.delta.theirs.removed} (bal ${hunk.balance.theirs})`
  const rows = [
    `  hunk ${hunk.index}  ${span}  ${sides}${hunk.basePresent ? '' : '  (no base)'}  → ${hunk.class}`,
    `    ${truncate(hunk.reason, WIDTH - 4)}`
  ]
  if (hunk.class !== 'union' && hunk.firstDiff !== null) {
    rows.push(`    first diff at file line ${hunk.firstDiff.line}:`)
    rows.push(`      ours   : ${truncate(hunk.firstDiff.ours ?? '(side is shorter)', WIDTH - 14)}`)
    rows.push(
      `      theirs : ${truncate(hunk.firstDiff.theirs ?? '(side is shorter)', WIDTH - 14)}`
    )
  }
  if (hunk.class === 'both-rewrote' || hunk.class === 'rename-replay') {
    rows.push('    candidate bodies:')
    for (const row of sideBySide(hunk.ours, hunk.theirs)) {
      rows.push(`      ${row}`)
    }
  }
  for (const side of hunk.duplicateFor) {
    rows.push(
      `    tail closing ${side}: ${truncate(hunk.tail.slice(0, hunk.tailCloses[side]).join(' ⏎ '), WIDTH - 25)}`
    )
  }
  return rows
}

function fileRows(file) {
  const status =
    file.status === null ? 'n/a' : `${file.status} ${UNMERGED_STATUS[file.status] ?? 'unmerged'}`
  const mix = [...new Set(file.hunkClasses)].map(
    (name) => `${name}×${file.hunkClasses.filter((one) => one === name).length}`
  )
  const sides = ['base', 'ours', 'theirs']
    .map((side) => `${side} ${file.sides[side] ? 'yes' : 'MISSING'}`)
    .join('  ')
  const rows = [
    truncate(
      `${file.path}  [${status}]  ${file.class}${mix.length > 0 ? `  (hunks: ${mix.join(', ')})` : ''}`,
      WIDTH
    ),
    `  sides: ${sides}`
  ]
  for (const note of file.notes) {
    rows.push(`  note: ${truncate(note, WIDTH - 8)}`)
  }
  if (file.expectedDeletion) {
    const { status, class: klass, reason } = file.expectedDeletion
    rows.push(`  deletion — ${status} (${klass})`)
    if (reason) {
      rows.push(`    why      ${truncate(reason, WIDTH - 13)}`)
    }
  }
  if (file.proposal) {
    rows.push(
      `  propose  ${file.proposal.action} — ${truncate(file.proposal.provenance, WIDTH - 22)}`
    )
    if (file.proposal.reason) {
      rows.push(`    why      ${truncate(file.proposal.reason, WIDTH - 13)}`)
    }
  }
  for (const entry of file.ledger) {
    rows.push(`  ledger — ${entry.title}`)
    if (entry.resolution) {
      const { action, verb, note } = entry.resolution
      const actionLabel = action === 'unknown' ? `${verb} (unrecognised verb)` : action
      rows.push(
        `    resolve  ${truncate([actionLabel, note].filter(Boolean).join(' — '), WIDTH - 13)}`
      )
    }
    for (const [label, field] of [
      ['decision', 'decision'],
      ['do not  ', 'doNot']
    ]) {
      entry[field].forEach((paragraph, index) =>
        rows.push(`    ${index === 0 ? label : '        '} ${truncate(paragraph, WIDTH - 13)}`)
      )
    }
  }
  for (const hunk of file.hunks) {
    rows.push(...hunkRows(hunk))
  }
  return rows
}

export function stateLine(state) {
  if (state.kind === 'rebase') {
    const progress = state.total > 0 ? `, step ${state.step}/${state.total}` : ''
    return `rebase in progress: ${state.branch || 'unknown branch'} onto ${state.onto}${progress}`
  }
  if (state.kind === 'none') {
    return 'no rebase, merge, cherry-pick or revert in progress'
  }
  return `${state.kind} in progress: ${state.head}${state.subject ? ` ${state.subject}` : ''}`
}

function headRows(result, ledger) {
  const rows = ['conflict triage — ADVISORY ONLY; a class is a hint, not a resolution']
  if (result.mode === 'live') {
    rows.push(stateLine(result.state))
  } else if (result.state.clean) {
    rows.push(`merge-tree ${result.state.base} + ${result.state.other}: clean merge, no conflicts`)
  } else {
    rows.push(
      `merge-tree ${result.state.base} + ${result.state.other}: ${result.files.length} conflicted path(s), tree ${result.state.tree.slice(0, 10)}`
    )
  }
  for (const note of [...result.notes, ledger.note]) {
    if (note) {
      rows.push(`note: ${note}`)
    }
  }
  return rows
}

export function renderText(result, ledger) {
  const rows = headRows(result, ledger)
  if (result.files.length === 0) {
    rows.push(
      '',
      result.mode === 'live'
        ? 'no conflicted paths — nothing to classify.'
        : 'no conflicts in that merge.'
    )
    if (result.mode === 'live' && result.state.kind !== 'none') {
      rows.push(
        `the ${result.state.kind} is still in progress; continue it when the tree is what you want.`
      )
    }
    return rows.join('\n')
  }
  rows.push(classCounts(result.files).line)
  for (const file of result.files) {
    rows.push('', ...fileRows(file))
  }
  rows.push(
    '',
    'every class above is advisory — confirm against the ledger decision before resolving.'
  )
  return rows.join('\n')
}

export function renderSummary(result, ledger) {
  const rows = headRows(result, ledger)
  if (result.files.length === 0) {
    rows.push('no conflicted paths')
    return rows.join('\n')
  }
  rows.push(classCounts(result.files).line)
  const width = Math.min(58, Math.max(...result.files.map((file) => file.path.length)) + 1)
  for (const file of result.files) {
    const titles = file.ledger.map((entry) => entry.title).join('; ')
    const deletion = file.expectedDeletion ? `  [deletion: ${file.expectedDeletion.status}]` : ''
    const row = `${truncate(file.path, width).padEnd(width)} ${(file.status ?? 'n/a').padEnd(4)} ${file.class.padEnd(18)} ${file.hunkCount} hunk(s)`
    rows.push(truncate(`${row}${deletion}${titles ? `  [ledger: ${titles}]` : ''}`, WIDTH))
  }
  return rows.join('\n')
}
