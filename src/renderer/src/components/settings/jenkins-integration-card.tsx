import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import type { JenkinsServerSummary } from '../../../../shared/jenkins-servers'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { JENKINS_INTEGRATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { cn } from '@/lib/utils'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { JenkinsServerDialog } from './jenkins-server-dialog'
import { translate } from '@/i18n/i18n'

type TestResult = { ok: boolean; message: string }

const TEST_RESULT_CLASSES: Record<'ok' | 'problem', string> = {
  ok: 'text-status-success',
  problem: 'text-destructive'
}

/**
 * The Jenkins servers Orca reads build details from.
 *
 * A user typically has several (per product, or per team), and which one a check belongs to is
 * decided by matching its URL against these prefixes — so this list is the whole configuration.
 */
export function JenkinsIntegrationCard(): React.JSX.Element {
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass(
    'flex flex-wrap items-center gap-x-3 gap-y-1'
  )
  const [servers, setServers] = useState<JenkinsServerSummary[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [dialogServer, setDialogServer] = useState<JenkinsServerSummary | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testByServerId, setTestByServerId] = useState<Record<string, TestResult>>({})
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Reads profiles and whether a token exists — never a token — so opening Settings cannot prompt
  // for keychain access.
  const loadServers = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.jenkins.listServers()
      if (mountedRef.current) {
        setServers(Array.isArray(next) ? next : [])
        setLoadFailed(false)
      }
    } catch {
      if (mountedRef.current) {
        setLoadFailed(true)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  const runTest = useCallback(
    async (serverId: string): Promise<void> => {
      setTestingId(serverId)
      setTestByServerId((current) => {
        const next = { ...current }
        delete next[serverId]
        return next
      })
      try {
        const result = await window.api.jenkins.testServer({ id: serverId })
        if (!mountedRef.current) {
          return
        }
        setTestByServerId((current) => ({
          ...current,
          [serverId]: !result
            ? {
                ok: false,
                message: translate(
                  'jenkins.settings.unavailable',
                  'Jenkins servers cannot be managed here.'
                )
              }
            : result.ok
              ? {
                  ok: true,
                  message: result.version
                    ? translate(
                        'jenkins.settings.connectedVersion',
                        'Connected to Jenkins {{value0}}',
                        {
                          value0: result.version
                        }
                      )
                    : translate('jenkins.settings.connected', 'Connected')
                }
              : { ok: false, message: result.error }
        }))
      } catch (error) {
        if (mountedRef.current) {
          setTestByServerId((current) => ({
            ...current,
            [serverId]: {
              ok: false,
              message:
                readIpcErrorMessage(error) ??
                translate('jenkins.settings.testFailed', 'Could not reach this Jenkins server.')
            }
          }))
        }
      } finally {
        if (mountedRef.current) {
          setTestingId(null)
        }
      }
    },
    [mountedRef]
  )

  const handleRemove = async (server: JenkinsServerSummary): Promise<void> => {
    setRemovingId(server.id)
    try {
      await window.api.jenkins.removeServer({ id: server.id })
      if (mountedRef.current) {
        setTestByServerId((current) => {
          const next = { ...current }
          delete next[server.id]
          return next
        })
      }
    } finally {
      if (mountedRef.current) {
        setRemovingId(null)
      }
      await loadServers()
    }
  }

  const count = servers?.length ?? 0
  const statusLabel = loadFailed
    ? translate('jenkins.settings.statusUnknown', 'Unknown')
    : count === 0
      ? translate('jenkins.settings.statusNone', 'Not configured')
      : translate('jenkins.settings.statusCount', '{{value0}} configured', { value0: count })

  return (
    <IntegrationCardShell
      settingsSectionId={JENKINS_INTEGRATION_SETTINGS_TARGET_ID}
      icon={<Server className="size-5" />}
      name="Jenkins"
      description={translate(
        'jenkins.settings.card.description',
        'Read build stages, status and timing for checks that link to Jenkins.'
      )}
      statusLabel={statusLabel}
      statusTone={count > 0 && !loadFailed ? 'connected' : 'neutral'}
      checking={servers === null && !loadFailed}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setDialogServer(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="size-3.5" />
          {translate('jenkins.settings.add', 'Add server')}
        </Button>
      }
    >
      {servers !== null && servers.length > 0 && (
        <IntegrationCardDetails>
          {servers.map((server) => {
            const result = testByServerId[server.id]
            return (
              <div key={server.id} className={subordinateRowClass}>
                <div className="min-w-0 flex-1 basis-[14rem]">
                  <div className="truncate text-xs font-medium text-foreground">{server.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {server.baseUrl}
                    {server.username ? ` · ${server.username}` : ''}
                    {server.hasToken
                      ? ''
                      : ` · ${translate('jenkins.settings.noToken', 'no token saved')}`}
                  </div>
                </div>
                {result && (
                  <span
                    role="status"
                    className={cn(
                      'min-w-0 flex-1 basis-[12rem] text-[11px]',
                      TEST_RESULT_CLASSES[result.ok ? 'ok' : 'problem']
                    )}
                  >
                    {result.message}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={testingId === server.id}
                    aria-busy={testingId === server.id}
                    onClick={() => void runTest(server.id)}
                  >
                    {testingId === server.id && <LoaderCircle className="size-3 animate-spin" />}
                    {translate('jenkins.settings.test', 'Test')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={translate('jenkins.settings.edit', 'Edit {{value0}}', {
                      value0: server.label
                    })}
                    onClick={() => {
                      setDialogServer(server)
                      setDialogOpen(true)
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={removingId === server.id}
                    aria-label={translate('jenkins.settings.remove', 'Remove {{value0}}', {
                      value0: server.label
                    })}
                    onClick={() => void handleRemove(server)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </IntegrationCardDetails>
      )}

      <JenkinsServerDialog
        key={dialogServer?.id ?? 'new'}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        server={dialogServer}
        onSaved={(saved) => {
          void loadServers().then(() => runTest(saved.id))
        }}
      />
    </IntegrationCardShell>
  )
}
