import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

export type AiVaultSessionCopyActions = {
  copySessionId: (session: AiVaultSession) => void
  copySessionPath: (session: AiVaultSession) => void
  openSessionLog: (session: AiVaultSession) => void
  revealSessionLog: (session: AiVaultSession) => void
  openSessionCwd: (session: AiVaultSession) => void
}

export function useAiVaultSessionCopyActions(): AiVaultSessionCopyActions {
  const copyText = useCallback(async (text: string, label: string): Promise<void> => {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
        value0: label
      })
    )
  }, [])

  const copySessionId = useCallback(
    (session: AiVaultSession): void => {
      void copyText(
        session.sessionId,
        translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
      )
    },
    [copyText]
  )

  const copySessionPath = useCallback(
    (session: AiVaultSession): void => {
      void copyText(
        session.filePath,
        translate('auto.components.right.sidebar.AiVaultPanel.logPath', 'Log path')
      )
    },
    [copyText]
  )

  const openSessionLog = useCallback(
    (session: AiVaultSession): void => void openAiVaultSessionLogInOrca(session),
    []
  )

  const revealSessionLog = useCallback(
    (session: AiVaultSession): void => void window.api.shell.openPath(session.filePath),
    []
  )

  const openSessionCwd = useCallback((session: AiVaultSession): void => {
    if (session.cwd) {
      void window.api.shell.openPath(session.cwd)
    }
  }, [])

  return { copySessionId, copySessionPath, openSessionLog, revealSessionLog, openSessionCwd }
}
