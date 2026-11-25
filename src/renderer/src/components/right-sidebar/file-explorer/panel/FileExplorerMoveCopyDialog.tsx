import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, CopyPlus, FolderInput, FolderUp, Loader2 } from 'lucide-react'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { FolderIcon } from '@/components/icons/FileTypeIcon'
import { FooterKey } from '@/components/worktree-jump/rows/worktree-jump-palette-row-content'
import { useTranslate } from '@/i18n/use-translate'
import { basename, dirname, getRelativePathInsideRoot } from '@/lib/path'
import type { DirCache, TreeNode } from '../tree/file-explorer-types'
import { fileExplorerDirDepth } from '../tree/file-explorer-dir-pages'
import { classifyMoveDestination } from '../mutations/file-explorer-move-copy-paths'
import type { FileExplorerMoveCopyRequest } from '../mutations/use-file-explorer-move-copy'

const isMac = navigator.userAgent.includes('Mac')
const HERE_VALUE = '__here'
const UP_VALUE = '__up'

type FileExplorerMoveCopyDialogProps = {
  request: FileExplorerMoveCopyRequest | null
  /** The workspace root; the chooser never browses above it. */
  rootPath: string | null
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  loadDir: (dirPath: string, depth: number) => Promise<boolean>
  onCancel: () => void
  onSubmit: (destDir: string) => void
}

function canChooseDestination(request: FileExplorerMoveCopyRequest, destDir: string): boolean {
  if (request.mode === 'copy') {
    return true
  }
  const verdicts = request.sources.map((source) => classifyMoveDestination(source.path, destDir))
  return !verdicts.includes('inside-source') && verdicts.includes('allowed')
}

/** Orca-rendered folder chooser over the explorer's own listings, so remote and folder workspaces browse the same way. */
export function FileExplorerMoveCopyDialog({
  request,
  rootPath,
  dirCache,
  loadingDirPaths,
  loadDir,
  onCancel,
  onSubmit
}: FileExplorerMoveCopyDialogProps): React.JSX.Element {
  const t = useTranslate()
  const [openedRequest, setOpenedRequest] = useState<FileExplorerMoveCopyRequest | null>(null)
  const [currentDir, setCurrentDir] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState('')
  if (request !== openedRequest) {
    // Each request opens on its own start folder with a clear filter.
    setOpenedRequest(request)
    setCurrentDir(
      request && rootPath && getRelativePathInsideRoot(request.startDir, rootPath) !== null
        ? request.startDir
        : rootPath
    )
    setQuery('')
    setHighlighted('')
  }

  const listing = currentDir ? dirCache[currentDir] : undefined
  // A read in flight leaves a pending empty entry, so the loading set is what says "not listed yet".
  const isLoading = currentDir !== null && (!listing || loadingDirPaths.has(currentDir))
  useEffect(() => {
    if (!request || !currentDir || dirCache[currentDir] || loadingDirPaths.has(currentDir)) {
      return
    }
    void loadDir(currentDir, fileExplorerDirDepth(rootPath, currentDir))
  }, [request, currentDir, dirCache, loadingDirPaths, loadDir, rootPath])

  const folders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    // Why skip outside links: main refuses tree writes under a folder link that leaves the project.
    return (listing?.children ?? []).filter(
      (child: TreeNode) =>
        child.isDirectory &&
        child.outsideProject !== true &&
        (!needle || child.name.toLowerCase().includes(needle))
    )
  }, [listing, query])

  if (!request || !currentDir || !rootPath) {
    return <CommandDialog open={false} />
  }

  const isMove = request.mode === 'move'
  const canChooseHere = canChooseDestination(request, currentDir)
  const canGoUp = currentDir !== rootPath
  const isFolderEnterable = (folder: TreeNode): boolean =>
    !isMove || !request.sources.some((source) => source.path === folder.path)
  // Why: while filtering only folders show, so Enter after typing enters a folder and never moves.
  const isFiltering = query.trim() !== ''
  const enabledValues = [
    ...(!isFiltering && canChooseHere ? [HERE_VALUE] : []),
    ...(!isFiltering && canGoUp ? [UP_VALUE] : []),
    ...folders.filter(isFolderEnterable).map((folder) => folder.path)
  ]
  const commandValue = enabledValues.includes(highlighted) ? highlighted : (enabledValues[0] ?? '')

  const navigate = (dirPath: string): void => {
    setCurrentDir(dirPath)
    setQuery('')
    setHighlighted('')
  }
  const goUp = (): void => {
    if (canGoUp) {
      navigate(dirname(currentDir))
    }
  }

  const relativeDir = getRelativePathInsideRoot(currentDir, rootPath)
  const currentLabel = relativeDir ? `${basename(rootPath)}/${relativeDir}` : basename(rootPath)
  const total = request.sources.length
  const name = basename(request.sources[0]?.path ?? '')
  const title = isMove
    ? total === 1
      ? t('fileExplorer.moveCopy.moveOneTitle', "Move '{{name}}' to…", { name })
      : t('fileExplorer.moveCopy.moveManyTitle', 'Move {{total}} items to…', { total })
    : total === 1
      ? t('fileExplorer.moveCopy.copyOneTitle', "Copy '{{name}}' to…", { name })
      : t('fileExplorer.moveCopy.copyManyTitle', 'Copy {{total}} items to…', { total })

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
      shouldFilter={false}
      title={title}
      description={t('fileExplorer.moveCopy.description', 'Choose a folder in this workspace.')}
      contentClassName="w-[520px] overflow-hidden"
      commandProps={{
        loop: true,
        value: commandValue,
        onValueChange: setHighlighted,
        className: 'jump-palette-command bg-transparent'
      }}
    >
      <div className="truncate px-3 pt-3 text-sm font-medium text-foreground">{title}</div>
      <CommandInput
        placeholder={t('fileExplorer.moveCopy.filterPlaceholder', 'Filter folders')}
        value={query}
        onValueChange={(value) => {
          setQuery(value)
          setHighlighted('')
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Backspace' &&
            query === '' &&
            canGoUp &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            goUp()
          }
        }}
        className="h-11 min-w-0 flex-1"
      />
      <CommandList>
        {isFiltering ? null : (
          <CommandGroup>
            <CommandItem
              value={HERE_VALUE}
              disabled={!canChooseHere}
              onSelect={() => onSubmit(currentDir)}
              className="cursor-pointer"
            >
              {isMove ? (
                <FolderInput className="size-3.5 text-muted-foreground" />
              ) : (
                <CopyPlus className="size-3.5 text-muted-foreground" />
              )}
              <span className="shrink-0 text-[13px] text-foreground">
                {isMove
                  ? t('fileExplorer.moveCopy.moveHere', 'Move here')
                  : t('fileExplorer.moveCopy.copyHere', 'Copy here')}
              </span>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {currentLabel}
              </span>
            </CommandItem>
            {canGoUp ? (
              <CommandItem value={UP_VALUE} onSelect={goUp} className="cursor-pointer">
                <FolderUp className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] text-foreground">
                  {t('fileExplorer.moveCopy.parentFolder', 'Parent folder')}
                </span>
              </CommandItem>
            ) : null}
          </CommandGroup>
        )}
        <CommandGroup heading={t('fileExplorer.moveCopy.foldersHeading', 'Folders')}>
          {isLoading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('fileExplorer.moveCopy.loading', 'Loading folders…')}
            </div>
          ) : listing?.error ? (
            <div role="alert" className="px-2 py-2 text-xs text-destructive">
              {listing.error}
            </div>
          ) : folders.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {isFiltering
                ? t('fileExplorer.moveCopy.noMatches', 'No matching folders')
                : t('fileExplorer.moveCopy.noFolders', 'No folders here')}
            </div>
          ) : (
            folders.map((folder) => (
              <CommandItem
                key={folder.path}
                value={folder.path}
                disabled={!isFolderEnterable(folder)}
                onSelect={() => navigate(folder.path)}
                className="cursor-pointer"
              >
                <FolderIcon
                  folderPath={folder.name}
                  open={false}
                  className="size-3.5 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {folder.name}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </CommandItem>
            ))
          )}
        </CommandGroup>
      </CommandList>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3.5 py-2 text-2xs text-muted-foreground">
        <FooterKey>{t('fileExplorer.moveCopy.enterKey', 'Enter')}</FooterKey>
        <span>{t('fileExplorer.moveCopy.select', 'Select')}</span>
        <FooterKey>{isMac ? '⌫' : t('fileExplorer.moveCopy.backspaceKey', 'Backspace')}</FooterKey>
        <span>{t('fileExplorer.moveCopy.up', 'Up')}</span>
        <FooterKey>{t('fileExplorer.moveCopy.escKey', 'Esc')}</FooterKey>
        <span>{t('fileExplorer.moveCopy.close', 'Close')}</span>
      </div>
    </CommandDialog>
  )
}
