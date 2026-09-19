import { translate } from '@/i18n/i18n'

export type SshTargetVisibilityApi = {
  setTargetHidden: (args: { id: string; hidden: boolean }) => Promise<unknown>
}

export type SshTargetVisibilityReport = {
  level: 'success' | 'error'
  message: string
  applied: boolean
}

/**
 * Hide or unhide a host Orca discovered in ~/.ssh/config, reporting the outcome for a
 * toast. `applied` says whether the store changed, so the caller only re-lists on success.
 */
export async function setSshTargetHiddenWithReport(
  api: SshTargetVisibilityApi,
  target: { id: string; label: string },
  hidden: boolean
): Promise<SshTargetVisibilityReport> {
  try {
    await api.setTargetHidden({ id: target.id, hidden })
    return {
      level: 'success',
      applied: true,
      message: hidden
        ? translate(
            'auto.components.settings.SshPane.hostHidden',
            '{{value0}} is hidden from host lists',
            { value0: target.label }
          )
        : translate(
            'auto.components.settings.SshPane.hostUnhidden',
            '{{value0}} is available again',
            {
              value0: target.label
            }
          )
    }
  } catch (err) {
    return {
      level: 'error',
      applied: false,
      message:
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.SshPane.hostVisibilityFailed',
              'Failed to update host visibility'
            )
    }
  }
}
