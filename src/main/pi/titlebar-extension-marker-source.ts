/**
 * The needs-input marker's own lane: its state, its re-assert, and the one exit that releases it.
 *
 * Why split: the generated titlebar extension is one closure, so these share the module-scope
 * state the marker handlers declare here instead of in the parent source, which keeps that
 * source under max-lines. Nothing here is standalone — splice it into the same closure.
 */
export function getPiTitlebarMarkerSourceLines(): string[] {
  return [
    '  // Why: pi already collapses nested prompts into one start/end pair, so this counter',
    '  // guards a close that never arrives, not nesting. A new turn cannot start under a',
    '  // dialog holding input focus, so agent_start doubles as recovery.',
    '  let promptDepth = 0',
    '  let markerPainted = false',
    '  let promptCtx = null',
    '  // Why: a separate handle from `timer`, which clearAnimation() nulls — the marker must',
    '  // survive a turn settling, a shutdown of the spinner, and the idle-maintenance cap.',
    '  let markerTimer = null',
    '  // Why: pi runs tool calls from one assistant message in parallel, so a dialog can be up',
    '  // inside one tool while a sibling finishes. Tracking what is still running is what tells a',
    '  // drained batch (the loop moved past the dialog) from a sibling that proves nothing.',
    '  let runningToolCalls = new Set()',
    '',
    '  function resetPromptState() {',
    '    stopMarkerReassert()',
    '    promptDepth = 0',
    '    markerPainted = false',
    '    promptCtx = null',
    '    runningToolCalls.clear()',
    '  }',
    '',
    '  function stopMarkerReassert() {',
    '    if (markerTimer) clearInterval(markerTimer)',
    '    markerTimer = null',
    '  }',
    '',
    '  function startMarkerReassert(ctx) {',
    '    stopMarkerReassert()',
    "    markerTimer = setInterval(() => paintTitle(ctx, () => getMarkedTitle(pi, '!')), MARKER_REASSERT_MS)",
    "    if (typeof markerTimer.unref === 'function') markerTimer.unref()",
    '  }',
    '',
    '  // Why: one exit for both the dialog close and the recovery path, so a released marker',
    '  // never leaves a re-assert timer or a held `!` behind: a live turn resumes its spinner in',
    '  // place, and an idle pane drops the marker rather than keep asking for attention.',
    '  function releaseMarker(ctx) {',
    '    const painter = resolvePainter(ctx) ?? promptCtx',
    '    promptDepth = 0',
    '    markerPainted = false',
    '    promptCtx = null',
    '    stopMarkerReassert()',
    '    if (timer) {',
    '      renderFrame(painter)',
    '      return',
    '    }',
    '    paintTitle(painter, () => getBaseTitle(pi))',
    '  }',
    ''
  ]
}
