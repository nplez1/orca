import { timeRendererStartupSyncStep } from './startup-diagnostics'

type StartupTerminalHintActions = {
  publishPersistedTerminalHints: () => void
}

export function publishStartupTerminalHints(actions: StartupTerminalHintActions): void {
  timeRendererStartupSyncStep('publish-terminal-startup-hints', () => {
    actions.publishPersistedTerminalHints()
  })
}
