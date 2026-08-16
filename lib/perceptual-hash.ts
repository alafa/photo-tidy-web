/**
 * Per-photo metrics used by similarity/duplicate clustering: pixel
 * dimensions, file size, and a perceptual hash. Pairwise comparison between
 * two photos' hashes (Hamming distance, thresholds) is deliberately NOT
 * implemented here — that's clustering logic, computed elsewhere from the
 * per-photo metrics this module produces.
 */
export interface PhotoMetrics {
  width: number
  height: number
  size: number
  /**
   * A 256-bit difference-hash (dHash), rendered as 64 lowercase hex
   * characters (4 bits each). `null` means the file could not be decoded
   * (e.g. HEIC in a browser without HEIC support) — this is a permanent
   * "no hash available" result, not "still computing" (see
   * `usePhotoMetrics`, which represents "still computing" as an absent map
   * entry rather than a `hash: null` metrics object).
   */
  hash: string | null
}

// dHash grid: one column wider than it is tall so every row yields exactly
// (HASH_GRID_WIDTH - 1) horizontal adjacent-pixel comparisons. 17x16 gives
// 16 comparisons/row * 16 rows = 256 bits total — a 16x16 hash, upsized from
// the original 8x8/64-bit hash to preserve more image detail per hash.
const HASH_GRID_WIDTH = 17
const HASH_GRID_HEIGHT = 16

// `createImageBitmap` is documented to never throw synchronously, but a
// pathological/corrupt file can make it hang -- neither resolve nor reject
// -- rather than fail cleanly. `computePhotoMetrics`'s try/catch only
// guards rejection; without a timeout, a hung decode would stall every
// remaining photo in the batch, since usePhotoMetrics's chunk loop awaits
// each chunk before starting the next. 10s is generous for a legitimate
// decode (even a large photo) while still giving up on a stuck one.
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
 * Computes width, height, file size, and a perceptual hash for a photo
 * File. Never throws: a decode failure (unsupported format/codec in this
 * browser) resolves with `hash: null` and `width`/`height` both `0`, so a
 * single undecodable file never blocks the rest of the batch (KTD3).
 */
export async function computePhotoMetrics(file: File): Promise<PhotoMetrics> {
  const size = file.size

  let bitmap: ImageBitmap
  try {
    bitmap = await withTimeout(
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      DECODE_TIMEOUT_MS,
      'createImageBitmap timed out decoding file'
    )
  } catch {
    return { width: 0, height: 0, size, hash: null }
  }

  try {
    const width = bitmap.width
    const height = bitmap.height
    let hash: string | null
    try {
      hash = await computeDHash(bitmap)
    } catch {
      // Canvas 2D context unavailable, or some other draw/resize-time
      // failure — still report the dimensions we already decoded, just no
      // hash.
      hash = null
    }
    return { width, height, size, hash }
  } finally {
    // Release the bitmap's backing memory as soon as we're done with it,
    // per the approach's explicit instruction — bitmaps are not
    // garbage-collector-friendly like normal JS objects.
    bitmap.close()
  }
}

/**
 * Hand-rolled difference-hash (dHash): downscale to a small fixed grid,
 * convert to grayscale, and record — per row — whether each pixel is
 * brighter than its right-hand neighbor. No DCT, no external library
 * (KTD1). Represented as 64 hex characters (256 bits, 4 bits per hex digit),
 * most-significant bit first, rows concatenated top to bottom.
 *
 * The downscale to 9x8 is done via a *second* `createImageBitmap` call with
 * `resizeWidth`/`resizeHeight`/`resizeQuality: 'high'`, not a single
 * `canvas.drawImage` at the final size. A single-step canvas draw at an
 * extreme ratio (a multi-thousand-pixel photo down to 9px) is a known
 * source of inconsistent, recompression-sensitive hashes — canvas 2D's
 * general-purpose draw path isn't guaranteed to do a proper area-average
 * for ratios that large, unlike the browser's dedicated bitmap-resize
 * path. This is the leading suspect for reports of clearly-similar photos
 * not landing close in Hamming distance.
 */
async function computeDHash(bitmap: ImageBitmap): Promise<string> {
  const resized = await withTimeout(
    createImageBitmap(bitmap, {
      resizeWidth: HASH_GRID_WIDTH,
      resizeHeight: HASH_GRID_HEIGHT,
      resizeQuality: 'high',
    }),
    DECODE_TIMEOUT_MS,
    'createImageBitmap timed out resizing bitmap'
  )

  let data: Uint8ClampedArray
  try {
    const canvas = document.createElement('canvas')
    canvas.width = HASH_GRID_WIDTH
    canvas.height = HASH_GRID_HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')

    ctx.drawImage(resized, 0, 0)
    data = ctx.getImageData(0, 0, HASH_GRID_WIDTH, HASH_GRID_HEIGHT).data
  } finally {
    resized.close()
  }

  const grayscale = new Array<number>(HASH_GRID_WIDTH * HASH_GRID_HEIGHT)
  for (let i = 0; i < grayscale.length; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    // Standard luminance weights.
    grayscale[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  let bits = ''
  for (let y = 0; y < HASH_GRID_HEIGHT; y++) {
    for (let x = 0; x < HASH_GRID_WIDTH - 1; x++) {
      const left = grayscale[y * HASH_GRID_WIDTH + x]
      const right = grayscale[y * HASH_GRID_WIDTH + x + 1]
      bits += left > right ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}
