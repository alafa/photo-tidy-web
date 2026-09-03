import { useState, useRef, useEffect } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { useTimestampEdit } from '@/hooks/useTimestampEdit'
import { formatDate } from '@/lib/datetime-local'
import { TrashIcon } from './icons'

/**
 * Shared chrome for the delete/zoom overlay buttons: absolutely positioned
 * in a bottom corner, sized via padding (not the glyph) so the tappable
 * region is a ~44x44px minimum around a visually compact icon.
 * stopPropagation on both pointerdown and click keeps the button isolated
 * from the image wrapper's own handlers -- pointerdown so dnd-kit's
 * PointerSensor never starts a drag from the icon, click so it never
 * toggles the card's selection state.
 */
function CardOverlayButton({
  position,
  ariaLabel,
  colorClassName,
  onActivate,
  children,
}: {
  position: 'left' | 'right'
  ariaLabel: string
  colorClassName: string
  onActivate?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onActivate?.()
      }}
      className={`absolute bottom-0 ${position === 'right' ? 'right-0' : 'left-0'} p-3 flex items-center justify-center ${colorClassName}`}
    >
      {children}
    </button>
  )
}

type Props = {
  entry: PhotoEntry
  objectUrl: string
  onNameChange?: (newName: string) => void
  onTimestampChange?: (newDate: Date | null) => void
  onSelect?: (checked: boolean) => void
  checked?: boolean
  /**
   * Pre-bound by the caller (see `PhotoGrid.renderCard`), mirroring how
   * `onSelect`/`onNameChange` are already pre-bound with this card's id --
   * `PhotoCard` itself doesn't know its own id, so this is a zero-arg
   * trigger rather than an `(id: string) => void` callback.
   */
  onDelete?: () => void
  /**
   * Pre-bound by the caller (see `PhotoGrid.renderCard`), mirroring
   * `onDelete` above -- `PhotoCard` itself doesn't know its own id, so this
   * is a zero-arg trigger rather than an `(id: string) => void` callback.
   */
  onZoom?: () => void
  /**
   * Reports whenever this card's own inline name/timestamp editing starts
   * or stops (`isEditingName || isEditingTimestamp`). `components/PhotoUploadPage.tsx`
   * (U2) uses this to know whether any card is mid-edit before its
   * document-level copy-mode Escape listener decides to exit copy mode --
   * without it, that listener would also fire (and exit copy mode) whenever
   * this card's own Escape handling below cancels an in-progress edit, since
   * neither `commitName`'s nor `commitTimestamp`'s Escape path calls
   * `stopPropagation`. Mirrors `onSelect`/`onNameChange`'s "takes the new
   * value, pre-bound with id by the caller" convention rather than
   * `onDelete`/`onZoom`'s zero-arg one.
   */
  onEditingChange?: (isEditing: boolean) => void
}

export default function PhotoCard({
  entry,
  objectUrl,
  onNameChange,
  onTimestampChange,
  onSelect,
  checked,
  onDelete,
  onZoom,
  onEditingChange,
}: Props) {
  const { filename, capturedAt } = entry
  const dateLabel = capturedAt ? formatDate(capturedAt) : 'No date'

  const [isEditingName, setIsEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(filename)

  const nameInputRef = useRef<HTMLInputElement>(null)

  // Latest `onEditingChange` kept in a ref (synced via its own effect,
  // never written during render -- this repo's lint config flags a
  // during-render ref write) so the editing-state effect below can depend
  // on only `[isEditingName, isEditingTimestamp]` -- not `onEditingChange`'s
  // own identity, which is a fresh closure every time `PhotoGrid.renderCard`
  // recomputes (e.g. on an unrelated `selectedIds` change; see
  // `PhotoGrid.tsx`'s `onSelect`/`onDelete`/`onZoom` for the same
  // non-memoized-per-id pattern). Without this indirection, that unrelated
  // churn would re-fire the editing-state effect on renders where editing
  // state itself never actually changed -- harmless (the registry update is
  // idempotent) but the same needless-effect-run class of issue this
  // codebase already guards against elsewhere (see `onNavigatePrev`/
  // `onNavigateNext`'s `useMemo` in `PhotoUploadPage.tsx`).
  const onEditingChangeRef = useRef(onEditingChange)
  useEffect(() => {
    onEditingChangeRef.current = onEditingChange
  }, [onEditingChange])

  const {
    isEditing: isEditingTimestamp,
    tsValue,
    setTsValue,
    inputRef: tsInputRef,
    startEdit: startEditTimestampBase,
    commit: commitTimestamp,
    cancel: cancelTimestamp,
  } = useTimestampEdit(capturedAt, onTimestampChange)

  // Reports the combined editing state to `onEditingChange` (see its doc
  // above) on every start/stop transition, plus once more on unmount as a
  // safety net -- e.g. if this card is removed from the grid while an edit
  // is still in progress -- so the caller's registry never gets stuck
  // reporting a phantom in-progress edit for an id that no longer renders.
  useEffect(() => {
    onEditingChangeRef.current?.(isEditingName || isEditingTimestamp)
    return () => onEditingChangeRef.current?.(false)
  }, [isEditingName, isEditingTimestamp])

  // Keep draft values in sync with external prop changes (e.g. batch operations)
  useEffect(() => {
    if (!isEditingName) setNameValue(filename)
  }, [filename, isEditingName])

  useEffect(() => {
    if (isEditingName) nameInputRef.current?.focus()
  }, [isEditingName])

  function startEditName() {
    if (!onNameChange) return
    cancelTimestamp()
    setNameValue(filename)
    setIsEditingName(true)
  }

  function commitName() {
    const trimmed = nameValue.trim()
    if (!trimmed) {
      setNameValue(filename)
    } else if (trimmed !== filename) {
      onNameChange!(trimmed)
    }
    setIsEditingName(false)
  }

  function cancelName() {
    setNameValue(filename)
    setIsEditingName(false)
  }

  function startEditTimestamp() {
    // Mirrors useTimestampEdit's own onTimestampChange-presence guard: only
    // cancel an in-progress name edit if timestamp editing is actually about
    // to start. Without this, clicking the date on a card with no
    // onTimestampChange wired up would silently discard an in-progress name
    // edit even though timestamp editing never activates.
    if (!onTimestampChange) return
    setIsEditingName(false)
    startEditTimestampBase()
  }

  function handleDeleteClick() {
    // Same commit-before-discard safety PhotoLightbox's delete button
    // established (KTD5): an in-progress timestamp edit must be committed,
    // not silently discarded, when the card is deleted mid-edit.
    if (isEditingTimestamp) commitTimestamp()
    onDelete?.()
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Image — click to toggle selection when selectable */}
      <div
        className={`relative rounded-md overflow-hidden ${onSelect ? 'cursor-pointer' : ''} ${checked ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`}
        onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(!checked) } : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer */}
        <img
          src={objectUrl}
          alt={filename}
          loading="lazy"
          className="w-full aspect-square object-cover bg-zinc-100"
        />
        {/* Google Photos origin badge */}
        {entry.source === 'google-photos' && (
          <div className="absolute top-1.5 left-1.5 bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full leading-none">
            G
          </div>
        )}
        {/* Selected checkmark overlay */}
        {checked && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
            <svg className="w-3 h-3 text-white dark:text-zinc-900" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
            </svg>
          </div>
        )}
        {/* Delete icon overlay — always visible, bottom-right. Distinct
            warning tone (rose) so it reads apart from the neutral zoom icon
            on the opposite corner. */}
        <CardOverlayButton
          position="right"
          ariaLabel="Delete photo"
          colorClassName="text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300"
          onActivate={handleDeleteClick}
        >
          <TrashIcon className="w-5 h-5" />
        </CardOverlayButton>
        {/* Zoom icon overlay — always visible, bottom-left, symmetric with
            the delete icon's bottom-right placement. Neutral color (zinc)
            rather than the delete icon's warning tone, so the two read as
            visually distinct at a glance despite matching size and
            always-visible treatment. */}
        <CardOverlayButton
          position="left"
          ariaLabel="Zoom photo"
          colorClassName="text-zinc-100 hover:text-white"
          onActivate={onZoom}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
            <circle cx="5" cy="5" r="3.5" />
            <path strokeLinecap="round" d="M10 10l-2.5-2.5" />
          </svg>
        </CardOverlayButton>
      </div>

      {/* Filename */}
      {isEditingName ? (
        <input
          ref={nameInputRef}
          type="text"
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitName() }
            if (e.key === 'Escape') { e.preventDefault(); cancelName() }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="text-sm font-medium text-zinc-900 bg-white dark:bg-zinc-900 dark:text-zinc-50 border border-zinc-300 dark:border-zinc-600 rounded px-1 w-full"
        />
      ) : (
        <p
          className={`text-sm font-medium truncate text-zinc-900 dark:text-zinc-50 ${onNameChange ? 'cursor-text hover:text-zinc-600 dark:hover:text-zinc-300' : ''}`}
          onClick={startEditName}
          title={onNameChange ? 'Click to edit name' : undefined}
        >
          {filename}
        </p>
      )}

      {/* Timestamp */}
      {isEditingTimestamp ? (
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
          onPointerDown={(e) => e.stopPropagation()}
          className="text-xs text-zinc-500 bg-white dark:bg-zinc-900 dark:text-zinc-400 border border-zinc-300 dark:border-zinc-600 rounded px-1 w-full"
        />
      ) : (
        <p
          className={`text-xs text-zinc-500 dark:text-zinc-400 ${onTimestampChange ? 'cursor-text hover:text-zinc-700 dark:hover:text-zinc-300' : ''}`}
          onClick={startEditTimestamp}
          title={onTimestampChange ? 'Click to edit date' : undefined}
        >
          {dateLabel}
        </p>
      )}
    </div>
  )
}
