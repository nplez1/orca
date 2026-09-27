import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { JenkinsServerSummary } from '../../../../shared/jenkins-servers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

/**
 * Add or edit one Jenkins server.
 *
 * The parent remounts this per server (`key`), so the fields seed from `server` without an effect
 * that could overwrite what the user is typing.
 */
export function JenkinsServerDialog({
  open,
  onOpenChange,
  server,
  onSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Server being edited, or null when adding. */
  server: JenkinsServerSummary | null
  onSaved: (server: JenkinsServerSummary) => void
}): React.JSX.Element {
  const mountedRef = useMountedRef()
  const labelId = useId()
  const baseUrlId = useId()
  const usernameId = useId()
  const apiTokenId = useId()

  const [label, setLabel] = useState(server?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(server?.baseUrl ?? '')
  const [username, setUsername] = useState(server?.username ?? '')
  const [apiToken, setApiToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = server !== null
  const canSubmit = baseUrl.trim().length > 0

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit || saving) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.jenkins.saveServer({
        ...(server ? { id: server.id } : {}),
        label,
        baseUrl,
        username,
        apiToken
      })
      if (!result) {
        setError(
          translate('jenkins.settings.unavailable', 'Jenkins servers cannot be managed here.')
        )
        return
      }
      if (!result.ok) {
        setError(result.error)
        return
      }
      onSaved(result.server)
      onOpenChange(false)
    } catch (submitError) {
      setError(
        readIpcErrorMessage(submitError) ??
          translate('jenkins.settings.saveFailed', 'Could not save this Jenkins server.')
      )
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? translate('jenkins.settings.editTitle', 'Edit Jenkins server')
                : translate('jenkins.settings.addTitle', 'Add Jenkins server')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'jenkins.settings.description',
                'Orca reads build stages and timing from this server for checks that link to it. The token is stored encrypted when your OS keychain is available.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor={labelId}>{translate('jenkins.settings.label', 'Name')}</Label>
            <Input
              id={labelId}
              value={label}
              placeholder={translate('jenkins.settings.labelPlaceholder', 'Build server')}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={baseUrlId}>{translate('jenkins.settings.baseUrl', 'Server URL')}</Label>
            <Input
              id={baseUrlId}
              value={baseUrl}
              required
              placeholder={translate(
                'jenkins.settings.baseUrlPlaceholder',
                'https://ci.example.com/jenkins'
              )}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'jenkins.settings.baseUrlHint',
                'Include the path Jenkins is served under, if it is not at the root.'
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={usernameId}>{translate('jenkins.settings.username', 'Username')}</Label>
            <Input
              id={usernameId}
              value={username}
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={apiTokenId}>
              {translate('jenkins.settings.apiToken', 'API token')}
            </Label>
            <Input
              id={apiTokenId}
              type="password"
              value={apiToken}
              autoComplete="off"
              placeholder={
                server?.hasToken
                  ? translate('jenkins.settings.tokenKeep', 'Leave blank to keep the saved token')
                  : ''
              }
              onChange={(event) => setApiToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'jenkins.settings.apiTokenHint',
                'Create one in Jenkins under your user profile → Configure → API Token.'
              )}
            </p>
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {translate('jenkins.settings.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit || saving} aria-busy={saving}>
              {saving && <LoaderCircle className="size-3.5 animate-spin" />}
              {translate('jenkins.settings.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
