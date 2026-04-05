import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPhotoDate } from './exif'

vi.mock('exifr', () => ({
  parse: vi.fn(),
}))

import { parse } from 'exifr'
const mockParse = vi.mocked(parse)

function makeFile(name = 'test.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8])], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPhotoDate', () => {
  it('returns DateTimeOriginal when present', async () => {
    const date = new Date('2025-01-03T14:32:00')
    mockParse.mockResolvedValue({ DateTimeOriginal: date })

    const result = await getPhotoDate(makeFile())

    expect(result).toBe(date)
  })

  it('falls back to DateTimeDigitized when DateTimeOriginal is absent', async () => {
    const date = new Date('2024-06-15T10:00:00')
    mockParse.mockResolvedValue({ DateTimeDigitized: date })

    const result = await getPhotoDate(makeFile())

    expect(result).toBe(date)
  })

  it('falls back to DateTime when DateTimeOriginal and DateTimeDigitized are absent', async () => {
    const date = new Date('2023-11-20T08:45:00')
    mockParse.mockResolvedValue({ DateTime: date })

    const result = await getPhotoDate(makeFile())

    expect(result).toBe(date)
  })

  it('returns null when no EXIF data is present', async () => {
    mockParse.mockResolvedValue(undefined)

    const result = await getPhotoDate(makeFile('photo.png'))

    expect(result).toBeNull()
  })

  it('returns null when EXIF data has no date tags', async () => {
    mockParse.mockResolvedValue({ Make: 'Canon', Model: 'EOS R5' })

    const result = await getPhotoDate(makeFile())

    expect(result).toBeNull()
  })

  it('returns null when exifr throws (corrupt EXIF)', async () => {
    mockParse.mockRejectedValue(new Error('Invalid EXIF segment'))

    const result = await getPhotoDate(makeFile())

    expect(result).toBeNull()
  })

  it('returns null when date field is not a Date object (e.g. raw string)', async () => {
    mockParse.mockResolvedValue({ DateTimeOriginal: '2025:01:03 14:32:00' })

    const result = await getPhotoDate(makeFile())

    expect(result).toBeNull()
  })
})
