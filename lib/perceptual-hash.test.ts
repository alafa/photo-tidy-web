import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computePhotoMetrics } from './perceptual-hash'

// --- test helpers -----------------------------------------------------
//
// jsdom can't decode real images, so createImageBitmap and the canvas 2D
// context are mocked at the same boundary usePhotos.test.ts mocks
// '@/lib/exif' — the fake ImageBitmap carries a pre-rendered 16x17 RGBA
// grid (`__grid`) that the mocked canvas context "draws" verbatim in
// getImageData, standing in for the real drawImage downscale.

const HASH_GRID_WIDTH = 17
const HASH_GRID_HEIGHT = 16

interface FakeBitmap {
  width: number
  height: number
  close: () => void
  __grid: Uint8ClampedArray
}

/** Builds a fake decoded bitmap from a HASH_GRID_HEIGHT-row x HASH_GRID_WIDTH-col grayscale grid. */
function makeFakeBitmap(rows: number[][], naturalWidth = 170, naturalHeight = 160): FakeBitmap {
  if (rows.length !== HASH_GRID_HEIGHT || rows.some((r) => r.length !== HASH_GRID_WIDTH)) {
    throw new Error(`test grid must be ${HASH_GRID_HEIGHT} rows x ${HASH_GRID_WIDTH} cols`)
  }
  const grid = new Uint8ClampedArray(HASH_GRID_WIDTH * HASH_GRID_HEIGHT * 4)
  for (let y = 0; y < HASH_GRID_HEIGHT; y++) {
    for (let x = 0; x < HASH_GRID_WIDTH; x++) {
      const v = rows[y][x]
      const idx = (y * HASH_GRID_WIDTH + x) * 4
      grid[idx] = v
      grid[idx + 1] = v
      grid[idx + 2] = v
      grid[idx + 3] = 255
    }
  }
  return { width: naturalWidth, height: naturalHeight, close: vi.fn(), __grid: grid }
}

// Monotonic increasing row -> every adjacent-pixel comparison is
// left < right -> every bit is 0 -> hash is all zeros.
const ASCENDING_ROW = Array.from({ length: HASH_GRID_WIDTH }, (_, i) =>
  Math.round((i * 255) / (HASH_GRID_WIDTH - 1))
)
// Same row with two adjacent values swapped near the end -> flips exactly
// one of the per-row bit comparisons (a "near duplicate" grid).
const ASCENDING_ROW_PERTURBED = (() => {
  const row = [...ASCENDING_ROW]
  const i = HASH_GRID_WIDTH - 3
  ;[row[i], row[i + 1]] = [row[i + 1], row[i]]
  return row
})()
// Monotonic decreasing row -> every bit is 1 -> hash is all ones, maximally
// different from the ascending grids (unrelated content).
const DESCENDING_ROW = [...ASCENDING_ROW].reverse()

function repeatRow(row: number[]): number[][] {
  return Array.from({ length: HASH_GRID_HEIGHT }, () => [...row])
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('hash length mismatch')
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const bitsA = parseInt(a[i], 16).toString(2).padStart(4, '0')
    const bitsB = parseInt(b[i], 16).toString(2).padStart(4, '0')
    for (let j = 0; j < 4; j++) {
      if (bitsA[j] !== bitsB[j]) distance++
    }
  }
  return distance
}

function makeFile(name: string, byteLength: number): File {
  return new File([new Uint8Array(byteLength)], name, { type: 'image/jpeg' })
}

// Routes fake bitmaps to specific File instances, and lets a test force a
// decode rejection, or a hang (never resolve/reject), for a given file.
let bitmapByFile: Map<File, FakeBitmap>
let rejectFiles: Set<File>
let hangFiles: Set<File>
let hangResize: boolean
let lastDrawnBitmap: FakeBitmap | null

beforeEach(() => {
  bitmapByFile = new Map()
  rejectFiles = new Set()
  hangFiles = new Set()
  hangResize = false
  lastDrawnBitmap = null

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (source: File | FakeBitmap) => {
      if (source instanceof File) {
        if (hangFiles.has(source)) {
          return new Promise<never>(() => {}) // never settles
        }
        if (rejectFiles.has(source)) {
          throw new Error('decode failed')
        }
        const bitmap = bitmapByFile.get(source)
        if (!bitmap) throw new Error(`no fake bitmap registered for file ${source.name}`)
        return bitmap
      }
      if (hangResize) {
        return new Promise<never>(() => {}) // never settles
      }
      // The resize call (decoded bitmap -> hash-grid bitmap): test
      // fixtures already carry the final grid via `__grid` regardless
      // of natural size, so "resizing" is a no-op passthrough — return a
      // fresh object with its own `close` spy so callers can close it
      // independently of the source bitmap.
      return { ...source, close: vi.fn() }
    })
  )

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    type: string
  ) {
    if (type !== '2d') return null
    return {
      drawImage: (img: unknown) => {
        lastDrawnBitmap = img as FakeBitmap
      },
      getImageData: () => ({
        data: lastDrawnBitmap!.__grid,
        width: HASH_GRID_WIDTH,
        height: HASH_GRID_HEIGHT,
      }),
    } as unknown as CanvasRenderingContext2D
  })
})

describe('computePhotoMetrics', () => {
  it('returns the file size directly from File.size', async () => {
    const file = makeFile('a.jpg', 12345)
    bitmapByFile.set(file, makeFakeBitmap(repeatRow(ASCENDING_ROW)))

    const result = await computePhotoMetrics(file)

    expect(result.size).toBe(12345)
  })

  it('produces near-identical hashes for the same content at different resolutions', async () => {
    const fileSmall = makeFile('small.jpg', 100)
    const fileLarge = makeFile('large.jpg', 5_000_000)
    // Same logical content, different decoded natural dimensions — the
    // dHash only looks at the downscaled grid, so resolution shouldn't
    // matter. A one-pixel perturbation stands in for the minor encoding
    // noise two different resolutions of the same shot would introduce.
    bitmapByFile.set(fileSmall, makeFakeBitmap(repeatRow(ASCENDING_ROW), 90, 80))
    bitmapByFile.set(fileLarge, makeFakeBitmap(repeatRow(ASCENDING_ROW_PERTURBED), 4000, 3000))

    const small = await computePhotoMetrics(fileSmall)
    const large = await computePhotoMetrics(fileLarge)

    expect(small.hash).not.toBeNull()
    expect(large.hash).not.toBeNull()
    // The single-column swap repeats once per row (16 rows now, not 8), so
    // it can flip at most one bit per row -- 16 bits, not the old 8.
    expect(hammingDistance(small.hash!, large.hash!)).toBeLessThanOrEqual(16)
  })

  it('produces far-apart hashes for unrelated content', async () => {
    const fileA = makeFile('a.jpg', 100)
    const fileB = makeFile('b.jpg', 100)
    bitmapByFile.set(fileA, makeFakeBitmap(repeatRow(ASCENDING_ROW)))
    bitmapByFile.set(fileB, makeFakeBitmap(repeatRow(DESCENDING_ROW)))

    const a = await computePhotoMetrics(fileA)
    const b = await computePhotoMetrics(fileB)

    expect(a.hash).not.toBeNull()
    expect(b.hash).not.toBeNull()
    // Full reversal flips every bit of the now-256-bit hash; half of that
    // (128) is a loose "very different" bound, scaled up from the old 64-bit
    // hash's 32-bit bound.
    expect(hammingDistance(a.hash!, b.hash!)).toBeGreaterThan(128)
  })

  it('resolves with hash: null (not a thrown error) when decode fails', async () => {
    const file = makeFile('unsupported.heic', 100)
    rejectFiles.add(file)

    await expect(computePhotoMetrics(file)).resolves.toEqual({
      width: 0,
      height: 0,
      size: 100,
      hash: null,
    })
  })

  it('reports decoded width/height from the bitmap on success', async () => {
    const file = makeFile('a.jpg', 100)
    bitmapByFile.set(file, makeFakeBitmap(repeatRow(ASCENDING_ROW), 4032, 3024))

    const result = await computePhotoMetrics(file)

    expect(result.width).toBe(4032)
    expect(result.height).toBe(3024)
  })

  it('closes the bitmap after use', async () => {
    const file = makeFile('a.jpg', 100)
    const bitmap = makeFakeBitmap(repeatRow(ASCENDING_ROW))
    bitmapByFile.set(file, bitmap)

    await computePhotoMetrics(file)

    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('resolves with real dimensions but hash: null when the bitmap decodes but no 2D canvas context is available', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    const file = makeFile('a.jpg', 100)
    const bitmap = makeFakeBitmap(repeatRow(ASCENDING_ROW), 4032, 3024)
    bitmapByFile.set(file, bitmap)

    const result = await computePhotoMetrics(file)

    expect(result).toEqual({ width: 4032, height: 3024, size: 100, hash: null })
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('resolves with hash: null (not a hang) when the initial decode never settles', async () => {
    vi.useFakeTimers()
    try {
      const file = makeFile('stuck.jpg', 100)
      hangFiles.add(file)

      const resultPromise = computePhotoMetrics(file)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(resultPromise).resolves.toEqual({
        width: 0,
        height: 0,
        size: 100,
        hash: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves with real dimensions but hash: null (not a hang) when the resize step never settles', async () => {
    vi.useFakeTimers()
    try {
      const file = makeFile('a.jpg', 100)
      bitmapByFile.set(file, makeFakeBitmap(repeatRow(ASCENDING_ROW), 4032, 3024))
      hangResize = true

      const resultPromise = computePhotoMetrics(file)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(resultPromise).resolves.toEqual({
        width: 4032,
        height: 3024,
        size: 100,
        hash: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
