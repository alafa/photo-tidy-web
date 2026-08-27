/**
 * Client-side base64 JPEG thumbnail generation for a photo `File`, capped
 * at ~300px on the longest side, for sending to photo-tidy-api's cluster
 * endpoint (its `"base64-encoded thumbnail"` request field). Adapts the
 * decode-and-resize technique the old (now-removed) local dHash module
 * used, but skips its `getImageData` pixel math — that was specific to
 * hashing; here `canvas.toDataURL()` is enough.
 */

const MAX_DIMENSION = 300
const JPEG_QUALITY = 0.8

// `createImageBitmap` is documented to never throw synchronously, but a
// pathological/corrupt file can make it hang -- neither resolve nor reject
// -- rather than fail cleanly. The same guard the old (now-removed) local
// dHash module used for this same rationale is needed here so a single
// stuck decode can't stall an entire batch of thumbnail generation.
const DECODE_TIMEOUT_MS = 10_000

/** Races `promise` against a timer; a timeout rejects the same way a real
 * decode failure would, so callers handle both identically. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Longest side capped at MAX_DIMENSION, aspect ratio preserved, never
 * upscaled: an image already at or under the cap keeps its own size.
 */
function computeTargetDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= MAX_DIMENSION || longest === 0) {
    return { width, height }
  }
  const scale = MAX_DIMENSION / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Produces a base64-encoded JPEG thumbnail (the `data:image/jpeg;base64,`
 * prefix stripped) for `file`, capped at ~300px on its longest side. Never
 * throws: an undecodable file, a hung decode, or a missing 2D canvas
 * context all resolve to `null` so one bad photo doesn't block a batch —
 * mirrors the never-throws convention the old (now-removed) local dHash
 * module's own metrics computation used. Callers exclude a `null` result's
 * photo from the cluster request rather than treating it as a hard error.
 */
export async function generateThumbnail(file: File): Promise<string | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await withTimeout(
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      DECODE_TIMEOUT_MS,
      'createImageBitmap timed out decoding file'
    )
  } catch {
    return null
  }

  try {
    const { width, height } = computeTargetDimensions(bitmap.width, bitmap.height)

    let resized: ImageBitmap
    try {
      resized = await withTimeout(
        createImageBitmap(bitmap, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        }),
        DECODE_TIMEOUT_MS,
        'createImageBitmap timed out resizing bitmap'
      )
    } catch {
      return null
    }

    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      ctx.drawImage(resized, 0, 0)
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
      const commaIndex = dataUrl.indexOf(',')
      return commaIndex === -1 ? null : dataUrl.slice(commaIndex + 1)
    } finally {
      resized.close()
    }
  } finally {
    // Release the bitmap's backing memory as soon as we're done with it —
    // bitmaps are not garbage-collector-friendly like normal JS objects.
    bitmap.close()
  }
}
