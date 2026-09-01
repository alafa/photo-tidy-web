import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  triggerDownload,
  buildPhotoZipBlob,
  buildOrderedZipEntries,
  sanitizeZipFilenameBase,
  buildZipFilename,
} from './download'
import type { PhotoEntry } from '@/hooks/usePhotos'

vi.mock('./exif-write', () => ({
  writeTimestamp: vi.fn(),
}))

import { writeTimestamp } from './exif-write'
const mockWriteTimestamp = vi.mocked(writeTimestamp)

vi.mock('client-zip', () => ({
  downloadZip: vi.fn(),
}))

import { downloadZip } from 'client-zip'
const mockDownloadZip = vi.mocked(downloadZip)

// Stub URL and DOM globals
const mockCreateObjectURL = vi.fn(() => 'blob:test-url')
const mockRevokeObjectURL = vi.fn()
vi.stubGlobal('URL', {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
})

function makeEntry(name: string, type = 'image/jpeg'): PhotoEntry {
  return {
    id: name,
    file: new File([], name, { type }),
    filename: name,
    capturedAt: new Date('2025-01-01T10:00:00Z'),
    uploadIndex: 0,
    source: 'local',
  }
}

type CapturedZipEntry = { name: string; lastModified: Date; input: Blob }
let capturedZipEntries: CapturedZipEntry[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteTimestamp.mockImplementation(async (file) => file)
  capturedZipEntries = []
  mockDownloadZip.mockImplementation((files) => {
    return {
      blob: async () => {
        for await (const f of files as AsyncIterable<CapturedZipEntry>) {
          capturedZipEntries.push(f)
        }
        return new Blob(['zip'], { type: 'application/zip' })
      },
    } as unknown as Response
  })
})

describe('triggerDownload', () => {
  it('creates an anchor with the correct download attribute and clicks it', () => {
    const clicks: string[] = []
    const mockClick = vi.fn(() => clicks.push('clicked'))
    vi.spyOn(document, 'createElement').mockReturnValueOnce(
      Object.assign(document.createElement('a'), { click: mockClick })
    )

    const blob = new Blob(['data'], { type: 'image/jpeg' })
    triggerDownload(blob, 'photo.jpg')

    expect(mockCreateObjectURL).toHaveBeenCalledWith(blob)
    expect(mockClick).toHaveBeenCalledTimes(1)
  })

  it('sets the download filename on the anchor', () => {
    let capturedDownload = ''
    const anchor = document.createElement('a')
    Object.defineProperty(anchor, 'download', {
      set: (v: string) => { capturedDownload = v },
      get: () => capturedDownload,
    })
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor)

    triggerDownload(new Blob(['x']), 'my-file.jpg')

    expect(capturedDownload).toBe('my-file.jpg')
  })

  it('revokes the object URL after a timeout', async () => {
    vi.useFakeTimers()

    triggerDownload(new Blob(['data']), 'photo.jpg')

    expect(mockRevokeObjectURL).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test-url')

    vi.useRealTimers()
  })
})

describe('buildPhotoZipBlob', () => {
  it('builds a Blob from N entries, calling writeTimestamp in the exact given order', async () => {
    const entries = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')]

    const blob = await buildPhotoZipBlob(entries)

    expect(blob).toBeInstanceOf(Blob)
    expect(mockDownloadZip).toHaveBeenCalledTimes(1)
    expect(mockWriteTimestamp).toHaveBeenCalledTimes(3)
    expect(mockWriteTimestamp.mock.calls[0][0]).toBe(entries[0].file)
    expect(mockWriteTimestamp.mock.calls[1][0]).toBe(entries[1].file)
    expect(mockWriteTimestamp.mock.calls[2][0]).toBe(entries[2].file)
  })

  it('de-duplicates a repeated filename by appending a numeric suffix before the extension', async () => {
    const entries = [makeEntry('photo.jpg'), makeEntry('photo.jpg')]

    await buildPhotoZipBlob(entries)

    expect(capturedZipEntries[0].name).toBe('photo.jpg')
    expect(capturedZipEntries[1].name).toBe('photo (2).jpg')
  })

  it('falls back to new Date() for capturedAt null, used for both writeTimestamp and lastModified', async () => {
    const entry = { ...makeEntry('photo.jpg'), capturedAt: null }

    await buildPhotoZipBlob([entry])

    const [, passedDate] = mockWriteTimestamp.mock.calls[0]
    expect(passedDate).toBeInstanceOf(Date)
    expect(capturedZipEntries[0].lastModified).toBe(passedDate)
  })

  it('sets the ZIP entry lastModified from capturedAt for a non-JPEG entry even though writeTimestamp passes bytes through unchanged', async () => {
    const entry = makeEntry('photo.png', 'image/png')

    await buildPhotoZipBlob([entry])

    expect(mockWriteTimestamp).toHaveBeenCalledWith(entry.file, entry.capturedAt)
    expect(capturedZipEntries[0].lastModified).toBe(entry.capturedAt)
    expect(capturedZipEntries[0].input).toBe(entry.file)
  })

  it('calls onProgress once per resolved entry with an increasing done and a constant total', async () => {
    const entries = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')]
    const onProgress = vi.fn()

    await buildPhotoZipBlob(entries, onProgress)

    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3)
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3)
    expect(onProgress).toHaveBeenNthCalledWith(3, 3, 3)
  })

  it('rejects and stops processing further entries when writeTimestamp rejects mid-batch, never producing a partial ZIP', async () => {
    const entries = [
      makeEntry('a.jpg'),
      makeEntry('b.jpg'),
      makeEntry('c.jpg'),
      makeEntry('d.jpg'),
      makeEntry('e.jpg'),
    ]
    mockWriteTimestamp
      .mockResolvedValueOnce(entries[0].file)
      .mockResolvedValueOnce(entries[1].file)
      .mockRejectedValueOnce(new Error('boom'))

    await expect(buildPhotoZipBlob(entries)).rejects.toThrow('boom')

    // Only entries 1-3 were ever handed to writeTimestamp -- entries 4-5
    // are never processed once entry 3 rejects.
    expect(mockWriteTimestamp).toHaveBeenCalledTimes(3)
  })

  it('de-duplicates three entries sharing the same filename by appending increasing numeric suffixes', async () => {
    const entries = [makeEntry('photo.jpg'), makeEntry('photo.jpg'), makeEntry('photo.jpg')]

    await buildPhotoZipBlob(entries)

    expect(capturedZipEntries.map((e) => e.name)).toEqual([
      'photo.jpg',
      'photo (2).jpg',
      'photo (3).jpg',
    ])
  })
})

describe('buildOrderedZipEntries', () => {
  function makeIndexedEntry(id: string, uploadIndex: number): PhotoEntry {
    return {
      id,
      file: new File([], id, { type: 'image/jpeg' }),
      filename: id,
      capturedAt: new Date('2025-01-01T10:00:00Z'),
      uploadIndex,
      source: 'local',
    }
  }

  it('returns entries in visualOrder order when every id is present', () => {
    const a = makeIndexedEntry('a', 0)
    const b = makeIndexedEntry('b', 1)
    const c = makeIndexedEntry('c', 2)
    const photosById = new Map([
      ['a', a],
      ['b', b],
      ['c', c],
    ])

    const result = buildOrderedZipEntries(['c', 'a', 'b'], photosById)

    expect(result.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })

  it('skips an id in visualOrder that is missing from photosById (deleted photo)', () => {
    const a = makeIndexedEntry('a', 0)
    const c = makeIndexedEntry('c', 2)
    const photosById = new Map([
      ['a', a],
      ['c', c],
    ])

    const result = buildOrderedZipEntries(['a', 'b', 'c'], photosById)

    expect(result.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('appends photosById entries missing from visualOrder at the end, ordered by uploadIndex', () => {
    const a = makeIndexedEntry('a', 0)
    const b = makeIndexedEntry('b', 1)
    const c = makeIndexedEntry('c', 2)
    const d = makeIndexedEntry('d', 3)
    const photosById = new Map([
      ['a', a],
      ['b', b],
      ['c', c],
      ['d', d],
    ])

    // b and d (KTD9) aren't in visualOrder at all -- appended afterward,
    // ordered by uploadIndex (b's 1 before d's 3).
    const result = buildOrderedZipEntries(['c', 'a'], photosById)

    expect(result.map((e) => e.id)).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('sanitizeZipFilenameBase', () => {
  it('replaces each filesystem-unsafe character with a dash', () => {
    expect(sanitizeZipFilenameBase('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('passes a name with no unsafe characters through unchanged', () => {
    expect(sanitizeZipFilenameBase('Trip 2024 Summer')).toBe('Trip 2024 Summer')
  })
})

describe('buildZipFilename', () => {
  it('appends .zip to an already-safe, non-empty albumName', () => {
    expect(buildZipFilename('Trip 2024')).toBe('Trip 2024.zip')
  })

  it('sanitizes an albumName containing unsafe characters before appending .zip', () => {
    expect(buildZipFilename('Trip/2024: Summer')).toBe('Trip-2024- Summer.zip')
  })

  it('falls back to photo-tidy-export-<today>.zip for an empty albumName', () => {
    expect(buildZipFilename('')).toMatch(/^photo-tidy-export-\d{4}-\d{2}-\d{2}\.zip$/)
  })

  it('falls back to photo-tidy-export-<today>.zip for a whitespace-only albumName', () => {
    expect(buildZipFilename('   ')).toMatch(/^photo-tidy-export-\d{4}-\d{2}-\d{2}\.zip$/)
  })
})
