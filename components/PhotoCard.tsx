import { useState, useRef, useEffect } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'

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

/** Parse a datetime-local string ("YYYY-MM-DDTHH:MM") as UTC clock time. */
function parseDatetimeLocalAsUTC(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0))
}

type Props = {
  entry: PhotoEntry
  objectUrl: string
  onNameChange?: (newName: string) => void
  onTimestampChange?: (newDate: Date | null) => void
  onSelect?: (checked: boolean) => void
  checked?: boolean
}

export default function PhotoCard({
  entry,
  objectUrl,
  onNameChange,
  onTimestampChange,
  onSelect,
  checked,
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
        {/* Selected checkmark overlay */}
        {checked && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
            <svg className="w-3 h-3 text-white dark:text-zinc-900" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
            </svg>
          </div>
        )}
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
