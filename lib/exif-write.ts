import { load, dump, insert, TagValues, IExif } from 'piexif-ts'

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function dataURLtoBlob(dataURL: string): Blob {
  const [header, data] = dataURL.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/**
 * Formats a Date as an EXIF date string "YYYY:MM:DD HH:MM:SS".
 * Uses UTC components because exifr stores EXIF dates via Date.UTC,
 * so UTC getters preserve the original "clock" time from the EXIF tag.
 */
export function formatExifDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = date.getUTCFullYear()
  const mo = pad(date.getUTCMonth() + 1)
  const d = pad(date.getUTCDate())
  const h = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const s = pad(date.getUTCSeconds())
  return `${y}:${mo}:${d} ${h}:${mi}:${s}`
}

/**
 * Writes a new timestamp into a JPEG file's EXIF data.
 * Updates DateTimeOriginal, DateTimeDigitized, and DateTime for maximum compatibility.
 * PNG/TIFF files are returned unchanged.
 * On any error, returns the original file as a fallback.
 */
export async function writeTimestamp(file: File, newDate: Date): Promise<Blob> {
  if (file.type !== 'image/jpeg') {
    return file
  }
  try {
    const dataURL = await readAsDataURL(file)
    let exifObj: IExif
    try {
      exifObj = load(dataURL)
    } catch {
      exifObj = {}
    }
    if (!exifObj['0th']) exifObj['0th'] = {}
    if (!exifObj.Exif) exifObj.Exif = {}

    const exifDateStr = formatExifDate(newDate)
    exifObj['0th'][TagValues.ImageIFD.DateTime] = exifDateStr
    exifObj.Exif[TagValues.ExifIFD.DateTimeOriginal] = exifDateStr
    exifObj.Exif[TagValues.ExifIFD.DateTimeDigitized] = exifDateStr

    const exifBinary = dump(exifObj)
    const modifiedDataURL = insert(exifBinary, dataURL)
    return dataURLtoBlob(modifiedDataURL)
  } catch {
    return file
  }
}
