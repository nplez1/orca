// Settings › Bots: folders of skills this computer's bots load, so a skills tree kept outside Orca
// (such as `~/.agents/skills`) reaches every bot here instead of being linked project by project.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

/** A path is a folder here only if it names one: a bare word would silently load nothing. */
function looksLikePath(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 1 && (trimmed.includes('/') || trimmed.includes('\\'))
}

export function BotSkillFoldersSection(): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const folders = settings?.botSkillFolders ?? []
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const folder = draft.trim()
    if (!looksLikePath(folder) || folders.includes(folder)) {
      return
    }
    void updateSettings({ botSkillFolders: [...folders, folder] })
    setDraft('')
  }
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.skillFolders', 'Skill folders')}
        description={t(
          'settings.bots.skillFoldersDescription',
          'Folders on this computer whose children are skills. Every bot here loads them beside the projects it links, so a skill can carry its tools with it.'
        )}
      />
      {folders.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {folders.map((folder) => (
            <li key={folder} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 break-all">{folder}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void updateSettings({
                    botSkillFolders: folders.filter((entry) => entry !== folder)
                  })
                }
              >
                {t('settings.bots.skillFoldersRemove', 'Remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t('settings.bots.skillFoldersAddLabel', 'Folder of skills')}
        </label>
        <Input
          id={inputId}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-80"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('settings.bots.skillFoldersPlaceholder', '~/.agents/skills')}
          aria-invalid={draft.trim().length > 0 && !looksLikePath(draft)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={!looksLikePath(draft)}>
          {t('settings.bots.skillFoldersAdd', 'Add folder')}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.bots.skillFoldersWhen',
          'A change reaches a bot with its next message. Each folder’s children must hold a SKILL.md that names the skill.'
        )}
      </p>
    </section>
  )
}
