import { useEffect, useRef, useState } from 'react'
import { useTimestampEdit } from '@/hooks/useTimestampEdit'
import { formatDate } from '@/lib/datetime-local'
import { ChevronLeftIcon, ChevronRightIcon, TrashIcon } from './icons'

type Props = {
  /** Used for the image's alt text. */
  filename: string
  objectUrl: string
  /** Currently-recorded capture timestamp, editable inline (see below). */
  capturedAt: Date | null
  onClose: () => void
  /** Pre-bound by the caller -- a zero-arg trigger, mirroring PhotoCard's onDelete. */
  onDelete: () => void
  onTimestampChange: (newDate: Date | null) => void
  /** Presence of each of these gates whether its nav control renders at all. */
  onNavigatePrev?: () => void
  onNavigateNext?: () => void
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const ACTION_BUTTON_POSITION_CLASSNAME = {
  'top-right': 'top-3 right-3',
  'top-left': 'top-3 left-3',
  left: 'left-3 top-1/2 -translate-y-1/2',
  right: 'right-3 top-1/2 -translate-y-1/2',
} as const

/**
 * Local counterpart to PhotoCard's `CardOverlayButton` for the close/delete/
 * prev/next controls -- not shared cross-file with that component, since the
 * two have genuinely different positioning schemes (PhotoCard's overlay
 * buttons are corner-anchored within a single image tile; this lightbox's
 * are edge-anchored against the whole viewport, four distinct positions).
 */
function LightboxActionButton({
  position,
  ariaLabel,
  colorClassName,
  onClick,
  buttonRef,
  children,
}: {
  position: keyof typeof ACTION_BUTTON_POSITION_CLASSNAME
  ariaLabel: string
  colorClassName: string
  onClick: (e: React.MouseEvent) => void
  buttonRef?: React.Ref<HTMLButtonElement>
  children: React.ReactNode
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={`absolute ${ACTION_BUTTON_POSITION_CLASSNAME[position]} p-3 flex items-center justify-center rounded-full ${colorClassName}`}
    >
      {children}
    </button>
  )
}

/**
 * Full-size photo viewer/editor. No portal, no external dialog library --
 * there is no existing modal precedent in this codebase (confirmed via repo
 * research), so focus management is implemented here from first principles:
 *   - on mount, focus moves to the close control
 *   - Tab/Shift+Tab is trapped within the lightbox's own focusable elements
 *   - on unmount (any close path), focus returns to whatever had it before
 *     the lightbox opened, if that element is still attached to the DOM
 *
 * Beyond viewing, this component now also supports:
 *   - deleting the current photo (`onDelete`)
 *   - navigating to the previous/next photo in the batch (`onNavigatePrev`/
 *     `onNavigateNext`, each optional -- their presence gates whether the
 *     corresponding nav control renders)
 *   - editing the photo's captured-at timestamp inline, via the same
 *     edit/commit/cancel state machine PhotoCard uses (`useTimestampEdit`)
 *
 * Because an in-progress timestamp edit shouldn't be silently discarded by
 * a delete/navigate/close action, every action path (delete button, nav
 * buttons, close button, backdrop click) commits a pending edit first. The
 * document-level keydown handler also defers to the active edit: Escape
 * cancels the edit rather than closing, and ArrowLeft/ArrowRight are left
 * alone (no navigation, no preventDefault) so the native datetime-local
 * input can handle them for its own segment navigation.
 */
export default function PhotoLightbox({
  filename,
  objectUrl,
  capturedAt,
  onClose,
  onDelete,
  onTimestampChange,
  onNavigatePrev,
  onNavigateNext,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const [imageFailed, setImageFailed] = useState(false)

  const {
    isEditing,
    tsValue,
    setTsValue,
    inputRef: tsInputRef,
    startEdit: startEditTimestamp,
    commit: commitTimestamp,
    cancel: cancelTimestamp,
  } = useTimestampEdit(capturedAt, onTimestampChange)

  const dateLabel = capturedAt ? formatDate(capturedAt) : 'No date'

  /**
   * If a timestamp edit is in progress, commit it before the actual action
   * runs (KTD5). Also folds in `stopPropagation`, since every action-button
   * call site needs it (keeps the click from also triggering the backdrop's
   * own onClick) -- `stopPropagation` defaults to true for that reason, with
   * an opt-out for the backdrop's own handler, which is the outermost
   * element and must NOT stop propagation.
   */
  function commitPendingEditThen(action: () => void, { stopPropagation = true } = {}) {
    return (e: React.MouseEvent) => {
      if (stopPropagation) e.stopPropagation()
      if (isEditing) commitTimestamp()
      action()
    }
  }

  // Capture the pre-open focus target before moving focus to the close
  // control, then restore it on unmount. Every close path (close-control
  // click, backdrop click, Escape) works by having the parent stop rendering
  // this component, so a single mount-effect cleanup covers all of them.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()

    return () => {
      // Guard against calling .focus() on a detached node -- e.g. the
      // originally-focused grid card may have been removed while the
      // lightbox was open (navigating/deleting through several photos).
      if (previouslyFocusedRef.current?.isConnected) {
        previouslyFocusedRef.current.focus()
      }
    }
  }, [])

  // Escape-to-close/cancel, arrow-key navigation, and the Tab focus trap
  // all need a document-level keydown listener, since focus may be anywhere
  // within the lightbox (or, in principle, nowhere) when any key is pressed.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditing) {
        if (e.key === 'Escape') {
          cancelTimestamp()
          return
        }
        // Do NOT preventDefault or act on arrow keys while editing -- the
        // native datetime-local input must still receive them for its own
        // internal segment navigation (R6).
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return
      } else {
        if (e.key === 'Escape') {
          onClose()
          return
        }
        if (e.key === 'ArrowLeft') {
          onNavigatePrev?.()
          return
        }
        if (e.key === 'ArrowRight') {
          onNavigateNext?.()
          return
        }
      }

      if (e.key !== 'Tab') return

      const root = rootRef.current
      if (!root) return

      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (e.shiftKey) {
        if (active === first || !(active instanceof Node) || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !(active instanceof Node) || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onNavigatePrev, onNavigateNext, isEditing, cancelTimestamp])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={commitPendingEditThen(onClose, { stopPropagation: false })}
    >
      <LightboxActionButton
        buttonRef={closeButtonRef}
        position="top-right"
        ariaLabel="Close"
        colorClassName="text-zinc-100 hover:text-white hover:bg-white/10"
        onClick={commitPendingEditThen(onClose)}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2 2l8 8M10 2L2 10" />
        </svg>
      </LightboxActionButton>

      <LightboxActionButton
        position="top-left"
        ariaLabel="Delete photo"
        colorClassName="text-rose-400 hover:text-rose-300 hover:bg-white/10"
        onClick={commitPendingEditThen(onDelete)}
      >
        <TrashIcon className="w-5 h-5" />
      </LightboxActionButton>

      {onNavigatePrev && (
        <LightboxActionButton
          position="left"
          ariaLabel="Previous photo"
          colorClassName="text-zinc-100 hover:text-white hover:bg-white/10"
          onClick={commitPendingEditThen(onNavigatePrev)}
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </LightboxActionButton>
      )}

      {onNavigateNext && (
        <LightboxActionButton
          position="right"
          ariaLabel="Next photo"
          colorClassName="text-zinc-100 hover:text-white hover:bg-white/10"
          onClick={commitPendingEditThen(onNavigateNext)}
        >
          <ChevronRightIcon className="w-5 h-5" />
        </LightboxActionButton>
      )}

      {imageFailed ? (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-col items-center gap-2 text-zinc-100 text-sm"
        >
          <p>Unable to load this image.</p>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer
        <img
          src={objectUrl}
          alt={filename}
          onClick={(e) => e.stopPropagation()}
          onError={() => setImageFailed(true)}
          className="max-w-full max-h-full object-contain rounded-md"
        />
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-3 left-1/2 -translate-x-1/2"
      >
        {isEditing ? (
          <input
            ref={tsInputRef}
            type="datetime-local"
            value={tsValue}
            onChange={(e) => setTsValue(e.target.value)}
            onBlur={commitTimestamp}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTimestamp() }
              if (e.key === 'Escape') { e.preventDefault(); cancelTimestamp() }
            }}
            className="text-xs text-zinc-900 bg-white dark:bg-zinc-900 dark:text-zinc-50 border border-zinc-300 dark:border-zinc-600 rounded px-1"
          />
        ) : (
          <p
            className="text-xs text-zinc-100 cursor-text hover:text-white"
            onClick={startEditTimestamp}
            title="Click to edit date"
          >
            {dateLabel}
          </p>
        )}
      </div>
    </div>
  )
}
