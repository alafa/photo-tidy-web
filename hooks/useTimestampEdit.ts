import { useCallback, useEffect, useRef, useState } from 'react'
import { parseDatetimeLocalAsUTC } from '@/lib/datetime-local'

/** Format a Date as "YYYY-MM-DDTHH:MM" using UTC components for datetime-local input pre-fill. */
function toDatetimeLocal(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}`
}

/**
 * Shared inline timestamp-editing state machine, extracted from PhotoCard so
 * PhotoLightbox can reuse the exact same edit/commit/cancel semantics rather
 * than porting a second, potentially-diverging copy.
 *
 * `onTimestampChange` is optional so the hook can be used in a context where
 * editing isn't wired up yet -- mirrors PhotoCard's existing
 * `onNameChange`-presence-gates-affordance convention: when it's absent,
 * `startEdit` is a no-op, so no edit affordance should be shown by the
 * caller either.
 *
 * Contract:
 *   - `commit()` calls `onTimestampChange` with the parsed date (or `null`
 *     for an empty value) and exits edit mode.
 *   - `cancel()` resets the draft value back to `capturedAt` and exits edit
 *     mode WITHOUT calling `onTimestampChange`.
 */
export function useTimestampEdit(
  capturedAt: Date | null,
  onTimestampChange?: (newDate: Date | null) => void
) {
  const [isEditing, setIsEditing] = useState(false)
  const [tsValue, setTsValue] = useState(capturedAt ? toDatetimeLocal(capturedAt) : '')
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the draft value in sync with external capturedAt changes (e.g.
  // batch operations) while not actively editing.
  useEffect(() => {
    if (!isEditing) setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
  }, [capturedAt, isEditing])

  // Autofocus the input when entering edit mode.
  useEffect(() => {
    if (isEditing) inputRef.current?.focus()
  }, [isEditing])

  // Memoized on their real dependencies only (NOT `tsValue`, since neither
  // function's logic depends on the current draft value) so callers that put
  // `cancel`/`startEdit` in a dependency array -- e.g. PhotoLightbox's
  // document keydown effect -- don't re-run that effect on every keystroke.
  const startEdit = useCallback(() => {
    if (!onTimestampChange) return
    setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
    setIsEditing(true)
  }, [capturedAt, onTimestampChange])

  // Deliberately NOT wrapped in useCallback: commit needs the live `tsValue`
  // to parse, so its identity legitimately changes per keystroke. Nothing
  // depends on `commit`'s identity (it isn't in the Lightbox effect's
  // dependency array), so that churn is harmless.
  function commit() {
    if (tsValue.trim() === '') {
      onTimestampChange?.(null)
    } else {
      const parsed = parseDatetimeLocalAsUTC(tsValue)
      if (parsed) onTimestampChange?.(parsed)
    }
    setIsEditing(false)
  }

  const cancel = useCallback(() => {
    setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
    setIsEditing(false)
  }, [capturedAt])

  return { isEditing, tsValue, setTsValue, inputRef, startEdit, commit, cancel }
}
