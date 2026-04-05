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
 * Downloads a single photo entry.
 * JPEG files have their EXIF timestamp updated before download.
 * PNG/TIFF files are downloaded as-is (writeTimestamp passes them through).
 */
export async function downloadPhoto(entry: PhotoEntry): Promise<void> {
  const blob = await writeTimestamp(entry.file, entry.capturedAt ?? new Date())
  triggerDownload(blob, entry.filename)
}

/**
 * Downloads all photos sequentially with a small delay between each
 * to avoid browser throttling of programmatic downloads.
 */
export async function downloadAll(
  photos: PhotoEntry[],
  delayMs = 60
): Promise<void> {
  for (const entry of photos) {
    await downloadPhoto(entry)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}
