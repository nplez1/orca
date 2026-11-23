// Step 3 of connecting an App: the id GitHub shows and the key it gave you, sent once to the host that
// seals it. The key never comes back, so this form starts empty every time.
import React, { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { githubAppCalls, githubAppErrorMessage } from '@/lib/github-app-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export function GitHubAppConnectForm({
  hostId,
  onConnected
}: {
  hostId: ExecutionHostId
  onConnected: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const appIdInputId = useId()
  const keyInputId = useId()
  const errorId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [appId, setAppId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsedAppId = Number(appId.trim())
  const ready =
    Number.isInteger(parsedAppId) && parsedAppId > 0 && privateKey.trim().length > 0 && !busy

  const submit = (): void => {
    if (!ready) {
      return
    }
    setBusy(true)
    setError(null)
    void githubAppCalls(hostId)
      .connect({ appId: parsedAppId, privateKey })
      .then(
        () => {
          setAppId('')
          setPrivateKey('')
          onConnected()
        },
        (caught: unknown) => {
          // A malformed paste is worth clearing; a refused id is worth keeping so it can be corrected.
          setError(
            githubAppErrorMessage(caught) ??
              t('bots.github.app.add.failed', 'Could not add the App on this computer.')
          )
        }
      )
      .finally(() => setBusy(false))
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="space-y-1">
        <label htmlFor={appIdInputId} className="text-xs font-medium">
          {t('bots.github.app.add.appIdLabel', 'App ID')}
        </label>
        <Input
          id={appIdInputId}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-40"
          aria-invalid={appId.trim().length > 0 && !(parsedAppId > 0)}
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder={t('bots.github.app.add.appIdPlaceholder', '123456')}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.github.app.add.appIdHint',
            'The number on the App’s settings page, next to “App ID”. It is not the number in the installation’s URL.'
          )}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={keyInputId} className="text-xs font-medium">
          {t('bots.github.app.add.keyLabel', 'Private key')}
        </label>
        <Textarea
          id={keyInputId}
          variant="code"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="h-24"
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
          placeholder={t(
            'bots.github.app.add.keyPlaceholder',
            'Paste the .pem GitHub downloaded, or pick the file'
          )}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {t('bots.github.app.add.pickFile', 'Choose .pem file')}
          </Button>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t(
              'bots.github.app.add.keyStays',
              'The key is locked by this computer’s keyring and never leaves it.'
            )}
          </span>
          <Button type="submit" size="xs" disabled={!ready}>
            {busy
              ? t('bots.github.app.add.checking', 'Checking with GitHub…')
              : t('bots.github.app.add.submit', 'Add App')}
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pem,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) {
              void file.text().then((text) => {
                setPrivateKey(text)
                setError(null)
              })
            }
          }}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
