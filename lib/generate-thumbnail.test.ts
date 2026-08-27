import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateThumbnail } from './generate-thumbnail'

// --- test helpers -----------------------------------------------------
//
// jsdom can't decode real images or rasterize a canvas, so
// createImageBitmap and the canvas 2D context / toDataURL are mocked at the
// same boundary lib/perceptual-hash.test.ts uses. The mocked
// createImageBitmap "resize" step just returns an object carrying whatever
// resizeWidth/resizeHeight it was asked for, and the mocked toDataURL
// encodes the canvas's actual pixel dimensions into its return value (as
// "WxH" after the fake base64 comma) so tests can assert on the dimensions
// that made it all the way through the resize -> canvas pipeline, without a
// real image codec.

interface FakeBitmap {
  width: number
  height: number
  close: () => void
}

function makeFakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() }
}

function makeFile(name: string): File {
  return new File([new Uint8Array(10)], name, { type: 'image/jpeg' })
}

let bitmapByFile: Map<File, FakeBitmap>
let rejectFiles: Set<File>
let hangFiles: Set<File>
let lastCanvas: { width: number; height: number } | null

beforeEach(() => {
  bitmapByFile = new Map()
  rejectFiles = new Set()
  hangFiles = new Set()
  lastCanvas = null

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(
      async (
        source: File | FakeBitmap,
        options?: { resizeWidth?: number; resizeHeight?: number }
      ) => {
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
        // The resize call (decoded bitmap -> capped-size bitmap): honor the
        // requested resizeWidth/resizeHeight so the pipeline's dimension
        // math is actually exercised.
        return {
          width: options?.resizeWidth ?? source.width,
          height: options?.resizeHeight ?? source.height,
          close: vi.fn(),
        }
      }
    )
  )

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    type: string
  ) {
    if (type !== '2d') return null
    lastCanvas = { width: this.width, height: this.height }
    return {
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D
  })

  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    return `data:image/jpeg;base64,${this.width}x${this.height}`
  })
})

describe('generateThumbnail', () => {
  it('produces a base64 payload (no data-url prefix) capped at 300px on the longest side', async () => {
    const file = makeFile('big.jpg')
    bitmapByFile.set(file, makeFakeBitmap(4032, 3024))

    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result).not.toMatch(/^data:/)

    const [w, h] = result!.split('x').map(Number)
    expect(Math.max(w, h)).toBe(300)
    expect(w).toBe(300)
    // Aspect ratio preserved: 4032/3024 = 4/3.
    expect(h).toBe(Math.round((3024 * 300) / 4032))
    expect(lastCanvas).toEqual({ width: w, height: h })
  })

  it('does not upscale a small image; it passes through at its own size', async () => {
    const file = makeFile('small.jpg')
    bitmapByFile.set(file, makeFakeBitmap(50, 50))

    const result = await generateThumbnail(file)

    expect(result).toBe('50x50')
  })

  it('resolves to null (not a thrown error) when the file cannot be decoded', async () => {
    const file = makeFile('corrupt.jpg')
    rejectFiles.add(file)

    await expect(generateThumbnail(file)).resolves.toBeNull()
  })

  it('resolves to null (not a hang) when the decode never settles', async () => {
    vi.useFakeTimers()
    try {
      const file = makeFile('stuck.jpg')
      hangFiles.add(file)

      const resultPromise = generateThumbnail(file)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(resultPromise).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
