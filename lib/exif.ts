import { parse } from 'exifr'

/**
 * Reads the capture timestamp from a browser File object using EXIF metadata.
 * Falls back through DateTimeOriginal → DateTimeDigitized → DateTime.
 * Returns null if no timestamp can be parsed or if an error occurs.
 */
export async function getPhotoDate(file: File): Promise<Date | null> {
  try {
    const data = await parse(file, {
      pick: ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime'],
    })

    if (!data) return null

    const raw: unknown =
      data.DateTimeOriginal ?? data.DateTimeDigitized ?? data.DateTime

    if (raw instanceof Date) return raw
    return null
  } catch {
    return null
  }
}
