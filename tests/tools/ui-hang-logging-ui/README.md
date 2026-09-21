# UI hang logging settings proof

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/ui-hang-logging-ui/run.mjs`.

The runner builds the production `AdvancedPane` with its real styles, renders it in a hidden
Electron window with a disposable HOME/ZDOTDIR/userData, and records evidence under
`.bench-fixtures/ui-hang-logging-*/`. It never reveals a window and closes its own app.

DOM assertions and screenshots cover:

- The **Debug Options** section renders under Advanced.
- The **Log UI hangs** switch starts off (`aria-checked="false"`) and shows no log path.
- Toggling it on sets `aria-checked="true"` and reveals the `ui-hangs.ndjson` path.

The `uiHangDiagnostics` preload surface is stubbed with a fixed path; this is a rendered
production-component check, not a full app IPC, persistence, or hang-detection test. The
detection behavior itself is covered by `src/main/diagnostics/*.test.ts` and
`src/renderer/src/lib/ui-hang-diagnostics/probe.test.ts`.
