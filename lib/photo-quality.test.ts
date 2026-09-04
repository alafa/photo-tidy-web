import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPhotoDimensions, pickBestPhoto } from './photo-quality'

// --- test helpers -----------------------------------------------------
//
// jsdom can't decode real images, so createImageBitmap is mocked at the
// same boundary lib/generate-thumbnail.test.ts uses: same global
// (`vi.stubGlobal('createImageBitmap', ...)`), same directory, same
// `withTimeout`/`DECODE_TIMEOUT_MS` guard under test (imported from
// generate-thumbnail.ts and re-exercised here through getPhotoDimensions).

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

beforeEach(() => {
  bitmapByFile = new Map()
  rejectFiles = new Set()
  hangFiles = new Set()

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (source: File) => {
      if (hangFiles.has(source)) {
        return new Promise<never>(() => {}) // never settles
      }
      if (rejectFiles.has(source)) {
        throw new Error('decode failed')
      }
      const bitmap = bitmapByFile.get(source)
      if (!bitmap) throw new Error(`no fake bitmap registered for file ${source.name}`)
      return bitmap
    })
  )
})

describe('getPhotoDimensions', () => {
  it('returns the bitmap actual width/height for a normal decodable file', async () => {
    const file = makeFile('photo.jpg')
    bitmapByFile.set(file, makeFakeBitmap(4032, 3024))

    const result = await getPhotoDimensions(file)

    expect(result).toEqual({ width: 4032, height: 3024 })
  })

  it('resolves to {width: 0, height: 0} (not a thrown error) when decode rejects', async () => {
    const file = makeFile('corrupt.jpg')
    rejectFiles.add(file)

    await expect(getPhotoDimensions(file)).resolves.toEqual({ width: 0, height: 0 })
  })

  it('resolves to {width: 0, height: 0} (not a hang) when the decode never settles', async () => {
    vi.useFakeTimers()
    try {
      const file = makeFile('stuck.jpg')
      hangFiles.add(file)

      const resultPromise = getPhotoDimensions(file)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(resultPromise).resolves.toEqual({ width: 0, height: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pickBestPhoto', () => {
  it('picks the higher resolution outright', () => {
    const result = pickBestPhoto([
      { id: 'a', width: 100, height: 100, size: 500, uploadIndex: 0 },
      { id: 'b', width: 200, height: 200, size: 100, uploadIndex: 1 },
    ])

    expect(result).toEqual({ winnerId: 'b', loserIds: ['a'] })
  })

  it('breaks a resolution tie toward the larger file size', () => {
    const result = pickBestPhoto([
      { id: 'a', width: 100, height: 100, size: 500, uploadIndex: 0 },
      { id: 'b', width: 100, height: 100, size: 900, uploadIndex: 1 },
    ])

    expect(result).toEqual({ winnerId: 'b', loserIds: ['a'] })
  })

  it('breaks a resolution-and-size tie toward the earliest uploadIndex', () => {
    const result = pickBestPhoto([
      { id: 'a', width: 100, height: 100, size: 500, uploadIndex: 3 },
      { id: 'b', width: 100, height: 100, size: 500, uploadIndex: 1 },
    ])

    expect(result).toEqual({ winnerId: 'b', loserIds: ['a'] })
  })

  it('handles exactly 2 candidates, returning a single-element loserIds', () => {
    const result = pickBestPhoto([
      { id: 'x', width: 300, height: 300, size: 10, uploadIndex: 0 },
      { id: 'y', width: 50, height: 50, size: 10, uploadIndex: 1 },
    ])

    expect(result.winnerId).toBe('x')
    expect(result.loserIds).toEqual(['y'])
  })

  it('resolves 4+ candidates with a mix of clear winners and ties to exactly one winner', () => {
    const candidates = [
      { id: 'low-res', width: 50, height: 50, size: 1000, uploadIndex: 0 },
      { id: 'tie-small-size', width: 200, height: 200, size: 100, uploadIndex: 2 },
      { id: 'tie-big-size-later', width: 200, height: 200, size: 300, uploadIndex: 4 },
      { id: 'tie-big-size-earlier', width: 200, height: 200, size: 300, uploadIndex: 1 },
    ]

    const result = pickBestPhoto(candidates)

    expect(result.winnerId).toBe('tie-big-size-earlier')
    expect(result.loserIds).toHaveLength(3)
    expect(new Set(result.loserIds)).toEqual(
      new Set(['low-res', 'tie-small-size', 'tie-big-size-later'])
    )
  })
})
