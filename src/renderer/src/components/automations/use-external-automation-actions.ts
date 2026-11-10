import { toast } from 'sonner'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations/external/external-automation'
import { useTranslate } from '@/i18n/use-translate'
import { runAsyncTaskWithFailure } from '@/lib/async-task-with-cleanup'
import { useAppStore } from '@/store'
import {
  externalAutomationActionKey,
  externalAutomationJobKey
} from './external-automation-scope-keys'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/** External manager actions always carry the scope that produced their row. */
export function useExternalAutomationActions({
  local,
  list,
  pageRefresh
}: AutomationsPageActionContext) {
  const t = useTranslate()
  const {
    setExternalActionKey,
    setSelectedAutomationRunPageId,
    setExternalDeleteTarget,
    externalDeleteTarget,
    selectedExternalKeyRef,
    selectExternalKey,
    setIsDetailOpen,
    setActivePaneTab
  } = local
  const { scopedExternal } = list

  const runExternalAction = async (
    scope: ExternalAutomationScope,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> => {
    setExternalActionKey(externalAutomationActionKey(scope, job.id, action))
    await runAsyncTaskWithFailure(
      async () => {
        await scopedExternal.runExternalAction(scope, job.id, action)
        if (action === 'run') {
          useAppStore.getState().recordFeatureInteraction('automation-run')
        }
        await pageRefresh.refresh({ awaitExternalManagers: true })
        if (action === 'delete') {
          const deletedKey = externalAutomationJobKey(scope, job.id)
          if (selectedExternalKeyRef.current === deletedKey) {
            selectExternalKey(null)
            setIsDetailOpen(false)
            setActivePaneTab('overview')
          }
        }
        toast.success(
          action === 'delete'
            ? t(
                'auto.components.automations.AutomationsPage.4c22bc9913',
                'External automation deleted.'
              )
            : action === 'run'
              ? t(
                  'auto.components.automations.AutomationsPage.4d7878402c',
                  'External automation queued.'
                )
              : action === 'pause'
                ? t(
                    'auto.components.automations.AutomationsPage.77c518a34b',
                    'External automation paused.'
                  )
                : t(
                    'auto.components.automations.AutomationsPage.37288942f0',
                    'External automation resumed.'
                  )
        )
      },
      async (error) => {
        await pageRefresh.refresh().catch(() => undefined)
        toast.error(
          error instanceof Error
            ? error.message
            : t(
                'auto.components.automations.AutomationsPage.126d726546',
                'External automation action failed.'
              )
        )
      },
      () => setExternalActionKey(null)
    )
  }

  const openAutomationRunPage = (run: AutomationRun): void => {
    setSelectedAutomationRunPageId(run.id)
  }
  const requestExternalAction = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ): void => {
    if (action === 'delete') {
      setExternalDeleteTarget({ manager, job, scope })
      return
    }
    void runExternalAction(scope, job, action)
  }
  const confirmDeleteExternalAutomation = async (): Promise<void> => {
    if (!externalDeleteTarget) {
      return
    }
    const target = externalDeleteTarget
    setExternalDeleteTarget(null)
    await runExternalAction(target.scope, target.job, 'delete')
  }

  return {
    runExternalAction,
    openAutomationRunPage,
    requestExternalAction,
    confirmDeleteExternalAutomation
  }
}

export type ExternalAutomationActions = ReturnType<typeof useExternalAutomationActions>
