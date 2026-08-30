/** Parse a datetime-local string ("YYYY-MM-DDTHH:MM") as UTC clock time. */
export function parseDatetimeLocalAsUTC(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0))
}

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

/** Format a captured-at Date for display (PhotoCard, PhotoLightbox). */
export function formatDate(date: Date): string {
  return dateFormatter.format(date)
}
