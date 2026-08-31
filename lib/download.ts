import { downloadZip } from 'client-zip'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { writeTimestamp } from './exif-write'

/**
 * Triggers a browser file download for the given Blob.
 * Uses a programmatic anchor click with a 100ms revoke delay (required by Firefox).
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 100)
}

/**
 * Resolves a collision-free in-zip filename. The first occurrence of a name
 * is left unchanged; each subsequent occurrence gets a numeric suffix
 * appended before the extension (`photo (2).jpg`, `photo (3).jpg`, ...).
 * Mutates `usedNames` with the name it returns.
 */
function resolveZipEntryName(filename: string, usedNames: Set<string>): string {
  if (!usedNames.has(filename)) {
    usedNames.add(filename)
    return filename
  }

  const dotIndex = filename.lastIndexOf('.')
  const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex)
  const extension = dotIndex === -1 ? '' : filename.slice(dotIndex)

  let counter = 2
  let candidate = `${base} (${counter})${extension}`
  while (usedNames.has(candidate)) {
    counter++
    candidate = `${base} (${counter})${extension}`
  }
  usedNames.add(candidate)
  return candidate
}

/**
 * Streams zip entries one at a time: runs the EXIF timestamp rewrite for
 * each photo, resolves a de-duplicated in-zip name, and reports progress —
 * all before yielding the entry, so at most one photo's data is in memory
 * beyond what `client-zip` is actively consuming.
 */
async function* generateZipEntries(
  entries: PhotoEntry[],
  onProgress?: (done: number, total: number) => void
) {
  const usedNames = new Set<string>()
  const total = entries.length
  let done = 0

  for (const entry of entries) {
    const capturedAt = entry.capturedAt ?? new Date()
    const blob = await writeTimestamp(entry.file, capturedAt)
    const name = resolveZipEntryName(entry.filename, usedNames)

    done++
    onProgress?.(done, total)

    yield { name, lastModified: capturedAt, input: blob }
  }
}

/**
 * Builds a single ZIP Blob from an ordered list of photo entries.
 * Reuses the existing per-photo EXIF timestamp rewrite (JPEGs get their
 * DateTimeOriginal/Digitized/DateTime updated; other formats pass through
 * unchanged), and sets each ZIP entry's lastModified from the same date.
 * Entries are streamed to `client-zip` via an async generator rather than
 * resolved into an array up front, to bound peak memory for large batches.
 * Does not re-sort `entries` — ordering is the caller's responsibility.
 */
export async function buildPhotoZipBlob(
  entries: PhotoEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const response = downloadZip(generateZipEntries(entries, onProgress))
  return response.blob()
}
