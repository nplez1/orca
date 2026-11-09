export type UpdateCheckVariant = 'default' | 'prerelease' | 'perf'
export type PrimaryEventSuppression = { failureKey: string; error: unknown }
/** Renderer channels the updater service pushes to the main window. */
export type UpdaterRendererChannel =
  | 'updater:status'
  | 'updater:quitAndInstallAborted'
  | 'updater:clearDismissal'
