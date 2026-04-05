import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeTimestamp, formatExifDate } from './exif-write'

// Tag numbers inlined because vi.mock factory is hoisted before const declarations
const TAG_DATETIME = 306
const TAG_DATETIME_ORIGINAL = 36867
const TAG_DATETIME_DIGITIZED = 36868

vi.mock('piexif-ts', () => ({
  load: vi.fn(),
  dump: vi.fn(),
  insert: vi.fn(),
  TagValues: {
    ImageIFD: { DateTime: 306 },
    ExifIFD: {
      DateTimeOriginal: 36867,
      DateTimeDigitized: 36868,
    },
  },
}))

import { load, dump, insert } from 'piexif-ts'
const mockLoad = vi.mocked(load)
const mockDump = vi.mocked(dump)
const mockInsert = vi.mocked(insert)

// Minimal fake base64 JPEG data URL (atob-safe)
const FAKE_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/AA=='

function makeJpeg(name = 'photo.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8])], name, { type: 'image/jpeg' })
}

function makePng(name = 'photo.png'): File {
  return new File([new Uint8Array([0x89, 0x50])], name, { type: 'image/png' })
}

function makeTiff(name = 'photo.tiff'): File {
  return new File([new Uint8Array([0x49, 0x49])], name, { type: 'image/tiff' })
}

beforeEach(() => {
  vi.clearAllMocks()
  // insert returns a fake data URL that dataURLtoBlob can parse
  mockLoad.mockReturnValue({ '0th': {}, Exif: {} })
  mockDump.mockReturnValue('exif-binary')
  mockInsert.mockReturnValue(FAKE_JPEG_DATA_URL)
})

describe('formatExifDate', () => {
  it('formats a UTC date as YYYY:MM:DD HH:MM:SS', () => {
    const date = new Date('2025-01-03T14:32:00Z')
    expect(formatExifDate(date)).toBe('2025:01:03 14:32:00')
  })

  it('zero-pads single-digit month, day, hours, minutes, seconds', () => {
    const date = new Date('2023-03-05T09:07:03Z')
    expect(formatExifDate(date)).toBe('2023:03:05 09:07:03')
  })
})

describe('writeTimestamp', () => {
  const testDate = new Date('2025-06-15T10:00:00Z')

  it('returns original file for PNG (pass-through)', async () => {
    const png = makePng()
    const result = await writeTimestamp(png, testDate)
    expect(result).toBe(png)
    expect(mockLoad).not.toHaveBeenCalled()
  })

  it('returns original file for TIFF (pass-through)', async () => {
    const tiff = makeTiff()
    const result = await writeTimestamp(tiff, testDate)
    expect(result).toBe(tiff)
    expect(mockLoad).not.toHaveBeenCalled()
  })

  describe('JPEG', () => {
    it('returns a Blob (not the original File)', async () => {
      const jpeg = makeJpeg()
      const result = await writeTimestamp(jpeg, testDate)
      expect(result).toBeInstanceOf(Blob)
      expect(result).not.toBe(jpeg)
    })

    it('calls load, dump, and insert once each', async () => {
      await writeTimestamp(makeJpeg(), testDate)
      expect(mockLoad).toHaveBeenCalledTimes(1)
      expect(mockDump).toHaveBeenCalledTimes(1)
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })

    it('sets all three date tags on the EXIF object passed to dump', async () => {
      await writeTimestamp(makeJpeg(), testDate)
      const exifObj = mockDump.mock.calls[0][0]
      const exifDateStr = formatExifDate(testDate)
      expect(exifObj['0th']?.[TAG_DATETIME]).toBe(exifDateStr)
      expect(exifObj.Exif?.[TAG_DATETIME_ORIGINAL]).toBe(exifDateStr)
      expect(exifObj.Exif?.[TAG_DATETIME_DIGITIZED]).toBe(exifDateStr)
    })

    it('calls insert with exif binary and the data URL from FileReader', async () => {
      await writeTimestamp(makeJpeg(), testDate)
      expect(mockInsert).toHaveBeenCalledWith('exif-binary', expect.stringMatching(/^data:image\/jpeg;base64,/))
    })

    it('seeds an empty EXIF object when load throws (no existing EXIF segment)', async () => {
      mockLoad.mockImplementation(() => {
        throw new Error('No EXIF segment')
      })
      const result = await writeTimestamp(makeJpeg(), testDate)
      // Should not throw; dump should still be called with valid structure
      expect(mockDump).toHaveBeenCalledTimes(1)
      const exifObj = mockDump.mock.calls[0][0]
      expect(exifObj['0th']).toBeDefined()
      expect(exifObj.Exif).toBeDefined()
      expect(result).toBeInstanceOf(Blob)
    })

    it('returns original file when an unrecoverable error occurs', async () => {
      mockInsert.mockImplementation(() => {
        throw new Error('Corrupt JPEG')
      })
      const jpeg = makeJpeg()
      const result = await writeTimestamp(jpeg, testDate)
      expect(result).toBe(jpeg)
    })
  })
})
