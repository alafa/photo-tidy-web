import { useState, useRef, useEffect } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { parseDatetimeLocalAsUTC } from '@/lib/datetime-local'

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  // exifr builds Date objects via Date.UTC, so EXIF clock times are stored
  // as UTC values. Format with timeZone: 'UTC' to display as-is.
  timeZone: 'UTC',
})

function formatDate(date: Date): string {
  return dateFormatter.format(date)
}

/** Format a Date as "YYYY-MM-DDTHH:MM" using UTC components for datetime-local input pre-fill. */
function toDatetimeLocal(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}`
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
}: Props) {
  const { filename, capturedAt } = entry
  const dateLabel = capturedAt ? formatDate(capturedAt) : 'No date'

  const [isEditingName, setIsEditingName] = useState(false)
  const [isEditingTimestamp, setIsEditingTimestamp] = useState(false)
  const [nameValue, setNameValue] = useState(filename)
  const [tsValue, setTsValue] = useState(capturedAt ? toDatetimeLocal(capturedAt) : '')

  const nameInputRef = useRef<HTMLInputElement>(null)
  const tsInputRef = useRef<HTMLInputElement>(null)

  // Keep draft values in sync with external prop changes (e.g. batch operations)
  useEffect(() => {
    if (!isEditingName) setNameValue(filename)
  }, [filename, isEditingName])

  useEffect(() => {
    if (!isEditingTimestamp) setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
  }, [capturedAt, isEditingTimestamp])

  useEffect(() => {
    if (isEditingName) nameInputRef.current?.focus()
  }, [isEditingName])

  useEffect(() => {
    if (isEditingTimestamp) tsInputRef.current?.focus()
  }, [isEditingTimestamp])

  function startEditName() {
    if (!onNameChange) return
    setIsEditingTimestamp(false)
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
    if (!onTimestampChange) return
    setIsEditingName(false)
    setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
    setIsEditingTimestamp(true)
  }

  function commitTimestamp() {
    if (tsValue.trim() === '') {
      onTimestampChange!(null)
    } else {
      const parsed = parseDatetimeLocalAsUTC(tsValue)
      if (parsed) onTimestampChange!(parsed)
    }
    setIsEditingTimestamp(false)
  }

  function cancelTimestamp() {
    setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
    setIsEditingTimestamp(false)
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
            a later unit adds to the opposite corner. Padding (not the glyph)
            expands the tappable region to a ~44x44px minimum, per KTD4, to
            keep mis-taps unlikely on a no-confirmation destructive action. */}
        <button
          type="button"
          aria-label="Delete photo"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete?.()
          }}
          className="absolute bottom-0 right-0 p-3 flex items-center justify-center text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2 2l8 8M10 2L2 10" />
          </svg>
        </button>
        {/* Zoom icon overlay — always visible, bottom-left, symmetric with
            the delete icon's bottom-right placement (KTD4). Neutral color
            (zinc) rather than the delete icon's warning tone, so the two
            read as visually distinct at a glance despite matching size and
            always-visible treatment. Same stopPropagation pairing (KTD3) as
            the delete icon so it never toggles selection or starts a drag. */}
        <button
          type="button"
          aria-label="Zoom photo"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onZoom?.()
          }}
          className="absolute bottom-0 left-0 p-3 flex items-center justify-center text-zinc-100 hover:text-white"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
            <circle cx="5" cy="5" r="3.5" />
            <path strokeLinecap="round" d="M10 10l-2.5-2.5" />
          </svg>
        </button>
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
