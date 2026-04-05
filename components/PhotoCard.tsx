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

type Props = {
  entry: PhotoEntry
  objectUrl: string
}

export default function PhotoCard({ entry, objectUrl }: Props) {
  const { filename, capturedAt } = entry
  const dateLabel = capturedAt ? formatDate(capturedAt) : 'No date'

  return (
    <div className="flex flex-col gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer */}
      <img
        src={objectUrl}
        alt={filename}
        loading="lazy"
        className="w-full aspect-square object-cover rounded-md bg-zinc-100"
      />
      <p className="text-sm font-medium truncate text-zinc-900">{filename}</p>
      <p className="text-xs text-zinc-500">{dateLabel}</p>
    </div>
  )
}
