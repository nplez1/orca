import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Globe } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import { openContextualHttpLink } from '@/lib/contextual-http-link'
import { isEditableTarget } from '@/lib/editable-target'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

type LinkContextMenuRequest = {
  url: string
  anchorX: number
  anchorY: number
  /** Focus returns here after the menu closes; may be a button that renders as a link. */
  origin: HTMLElement
}

// Shares the menu-row shape the browser page context menu ships, so link menus read as one family.
const MENU_ITEM_CLASS =
  'relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 focus:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14 dark:focus:bg-white/14'

/** Web links only: file:, blob:, and in-app routes keep the browser's own context menu. */
function contextMenuLinkUrl(event: MouseEvent): { url: string; origin: HTMLElement } | null {
  if (!(event.target instanceof Element)) {
    return null
  }
  // Why: a cancelled DOM contextmenu suppresses Electron's 'context-menu' event, which is what
  // supplies cut/copy/paste, spelling, and formatting inside the editor and composers.
  if (isEditableTarget(event.target)) {
    return null
  }
  const rawHref = event.target.closest('a[href]')?.getAttribute('href') ?? null
  if (rawHref) {
    // Only authored absolute web URLs: a relative href resolves against the dev-server origin,
    // and an anchor with any other scheme keeps the browser's own menu.
    if (!/^https?:\/\//i.test(rawHref)) {
      return null
    }
    const anchor = event.target.closest('a[href]')
    return anchor instanceof HTMLAnchorElement ? { url: rawHref, origin: anchor } : null
  }
  // Non-anchor affordances opt in with data-link-url, so a button-styled link gets the same menu.
  const declared = event.target.closest<HTMLElement>('[data-link-url]')
  const declaredUrl = declared?.dataset.linkUrl
  return declared && declaredUrl && /^https?:\/\//i.test(declaredUrl)
    ? { url: declaredUrl, origin: declared }
    : null
}

/**
 * Gives every web link in the app the same right-click menu: open in Orca's browser, open in the
 * system browser, or copy the address. Mounted once at the app root so no surface has to opt in.
 */
export function AppLinkContextMenu(): React.JSX.Element {
  const [request, setRequest] = useState<LinkContextMenuRequest | null>(null)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const { copyText, status: copyStatus } = useClipboardTextCopyFeedback(request?.url ?? '')
  const contentRef = useRef<HTMLDivElement>(null)

  const onContextMenu = useEffectEvent((event: MouseEvent): void => {
    const link = contextMenuLinkUrl(event)
    if (!link) {
      return
    }
    // Claim the gesture from card-level menus: the pointer is on a link, so the link menu wins.
    event.preventDefault()
    event.stopPropagation()
    setRequest({
      url: link.url,
      anchorX: event.clientX,
      anchorY: event.clientY,
      origin: link.origin
    })
  })

  useEffect(() => {
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => document.removeEventListener('contextmenu', onContextMenu, true)
  }, [])

  // Radix skips outside dismissal when the click's propagation is stopped, which sidebar cards do.
  const dismissOnOutsidePointerDown = useEffectEvent((event: PointerEvent): void => {
    if (!request || (event.target instanceof Node && contentRef.current?.contains(event.target))) {
      return
    }
    setRequest(null)
  })
  useEffect(() => {
    if (!request) {
      return
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointerDown, true)
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointerDown, true)
  }, [request])

  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => new DOMRect(request?.anchorX ?? 0, request?.anchorY ?? 0, 0, 0)
      }
    }),
    [request?.anchorX, request?.anchorY]
  )

  const close = (): void => setRequest(null)
  const restoreFocus = (): void => {
    if (request?.origin.isConnected) {
      request.origin.focus({ preventScroll: true })
    }
  }
  const run = (action: () => void): void => {
    close()
    action()
  }

  const copyLabel =
    copyStatus === 'copied'
      ? translate('auto.components.link.actions.copied', 'Copied')
      : translate('auto.components.link.actions.copyLink', 'Copy Link')

  return (
    <Popover
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      {request ? (
        <PopoverContent
          ref={contentRef}
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          className="z-[160] w-max min-w-52 max-w-[min(21rem,calc(100vw-1rem))]"
          data-app-link-context-menu
          // Why: the layer is portalled from App, so a modal dialog would read a row click as its
          // own outside interaction and dismiss itself mid-action.
          onPointerDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={restoreFocus}
        >
          <div className="flex flex-col gap-0.5 p-1">
            <div className="mb-0.5 flex items-center gap-1 overflow-hidden border-b border-border px-2 py-1">
              <span className="line-clamp-2 min-w-0 flex-1 break-all" title={request.url}>
                {request.url}
              </span>
            </div>
            {activeWorktreeId ? (
              <LinkMenuRow
                icon={<Globe className="size-3.5 text-muted-foreground" />}
                label={translate(
                  'auto.components.link.actions.openInOrcaBrowser',
                  'Open in Orca Browser'
                )}
                onRun={() =>
                  run(() =>
                    openContextualHttpLink(request.url, {
                      worktreeId: activeWorktreeId,
                      forceDestination: 'orca'
                    })
                  )
                }
              />
            ) : null}
            <LinkMenuRow
              icon={<ExternalLink className="size-3.5 text-muted-foreground" />}
              label={translate(
                'auto.components.link.actions.openInSystemBrowser',
                'Open in System Browser'
              )}
              onRun={() =>
                run(() =>
                  openContextualHttpLink(request.url, {
                    worktreeId: activeWorktreeId,
                    forceDestination: 'system'
                  })
                )
              }
            />
            <LinkMenuRow
              icon={
                copyStatus === 'copied' ? (
                  <Check className="size-3.5 text-muted-foreground" />
                ) : (
                  <Copy className="size-3.5 text-muted-foreground" />
                )
              }
              label={copyLabel}
              onRun={() => void copyText()}
            />
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

function LinkMenuRow({
  icon,
  label,
  onRun
}: {
  icon: React.ReactNode
  label: string
  onRun: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={cn(MENU_ITEM_CLASS)} onClick={onRun}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left" title={label}>
        {label}
      </span>
    </button>
  )
}
